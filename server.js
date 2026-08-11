require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const { pool, initDb } = require('./db');
const { calcularFrete } = require('./shipping');
const { enviarEmailNovoPedido } = require('./email');

const app = express();
app.use(cors());
app.use(express.json());

const ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
const SITE_URL = process.env.SITE_URL || 'https://www.cafesograos.com.br';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ACCESS_TOKEN) {
  console.warn('AVISO: MERCADOPAGO_ACCESS_TOKEN não está definido. Configure o .env antes de aceitar pagamentos.');
}

const client = new MercadoPagoConfig({ accessToken: ACCESS_TOKEN || 'TEST-TOKEN' });

// Autorização OAuth do Melhor Envio (rodar uma vez, manualmente, logado como admin).
app.get('/oauth/melhorenvio/connect', (req, res) => {
  const redirectUri = `${req.protocol}://${req.get('host')}/oauth/melhorenvio/callback`;
  const url = new URL('https://melhorenvio.com.br/oauth/authorize');
  url.searchParams.set('client_id', process.env.MELHORENVIO_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'shipping-calculate');
  res.redirect(url.toString());
});

app.get('/oauth/melhorenvio/callback', async (req, res) => {
  try {
    const redirectUri = `${req.protocol}://${req.get('host')}/oauth/melhorenvio/callback`;
    const tokenRes = await fetch('https://melhorenvio.com.br/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: process.env.MELHORENVIO_CLIENT_ID,
        client_secret: process.env.MELHORENVIO_CLIENT_SECRET,
        redirect_uri: redirectUri,
        code: req.query.code
      })
    });
    if (!tokenRes.ok) throw new Error(await tokenRes.text());
    const data = await tokenRes.json();
    const expires_at = new Date(Date.now() + data.expires_in * 1000);

    if (pool) {
      await pool.query('DELETE FROM melhorenvio_tokens');
      await pool.query(
        'INSERT INTO melhorenvio_tokens (access_token, refresh_token, expires_at) VALUES ($1,$2,$3)',
        [data.access_token, data.refresh_token, expires_at]
      );
    }
    res.send('Melhor Envio conectado com sucesso! Pode fechar esta aba.');
  } catch (err) {
    console.error('Erro na autorização do Melhor Envio:', err.message);
    res.status(500).send('Falha ao conectar com o Melhor Envio: ' + err.message);
  }
});

// Calcula o frete (Melhor Envio) a partir do CEP de destino e peso total do carrinho (kg).
app.post('/api/calcular-frete', async (req, res) => {
  try {
    const { cep, pesoKg } = req.body;
    const frete = await calcularFrete(cep, Number(pesoKg));
    res.json(frete);
  } catch (err) {
    console.error('Erro ao calcular frete:', err.message);
    res.status(400).json({ error: 'Não foi possível calcular o frete. Confira o CEP.' });
  }
});

// Cria uma preferência de pagamento a partir dos itens do carrinho + dados de entrega,
// salva o pedido no banco e devolve o link (init_point) para o checkout do Mercado Pago.
app.post('/api/create-preference', async (req, res) => {
  try {
    const { items, cliente, entrega, frete } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Carrinho vazio ou inválido.' });
    }
    if (!cliente?.nome || !cliente?.email || !entrega?.cep) {
      return res.status(400).json({ error: 'Dados de entrega incompletos.' });
    }

    const line_items = items.map((item) => ({
      title: String(item.title).slice(0, 250),
      quantity: Math.max(1, parseInt(item.quantity) || 1),
      unit_price: Number(item.unit_price),
      currency_id: 'BRL'
    }));

    const shippingCost = Number(frete) || 0;
    if (shippingCost > 0) {
      line_items.push({
        title: 'Frete',
        quantity: 1,
        unit_price: shippingCost,
        currency_id: 'BRL'
      });
    }

    const total = line_items.reduce((sum, i) => sum + i.unit_price * i.quantity, 0);

    const preference = new Preference(client);
    const result = await preference.create({
      body: {
        items: line_items,
        payer: { name: cliente.nome, email: cliente.email },
        back_urls: {
          success: `${SITE_URL}/sucesso.html`,
          failure: `${SITE_URL}/falha.html`,
          pending: `${SITE_URL}/pendente.html`
        },
        auto_return: 'approved',
        notification_url: `${req.protocol}://${req.get('host')}/webhook`
      }
    });

    if (pool) {
      await pool.query(
        `INSERT INTO orders
          (preference_id, status, customer_name, customer_email, customer_phone, cep, address, address_number, address_complement, neighborhood, city, state, items, shipping_cost, total)
         VALUES ($1,'pending',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          result.id,
          cliente.nome,
          cliente.email,
          cliente.telefone || null,
          entrega.cep,
          entrega.endereco,
          entrega.numero,
          entrega.complemento || null,
          entrega.bairro,
          entrega.cidade,
          entrega.estado,
          JSON.stringify(items),
          shippingCost,
          total
        ]
      );
    }

    res.json({ init_point: result.init_point });
  } catch (err) {
    console.error('Erro ao criar preferência:', err);
    res.status(500).json({ error: 'Erro ao criar pagamento.' });
  }
});

// Recebe as notificações de pagamento do Mercado Pago (webhook/IPN).
// Aceita GET (teste de URL do painel e IPN antigo) e POST (webhooks novos).
app.all('/webhook', async (req, res) => {
  try {
    const topic = req.query.topic || req.query.type || req.body?.type;
    const id = req.query.id || req.body?.data?.id;

    if (topic === 'payment' && id) {
      const payment = new Payment(client);
      const info = await payment.get({ id });
      console.log(`Notificação de pagamento ${id}: status "${info.status}"`);

      if (pool && info.preference_id) {
        const { rows } = await pool.query(
          `UPDATE orders SET status = $1, payment_id = $2 WHERE preference_id = $3 RETURNING *`,
          [info.status, String(id), info.preference_id]
        );
        const order = rows[0];
        if (order && info.status === 'approved') {
          await enviarEmailNovoPedido(order);
        }
      }
    } else {
      console.log('Notificação recebida do Mercado Pago:', { topic, id });
    }
  } catch (err) {
    console.error('Erro ao processar notificação do Mercado Pago:', err);
  }
  // Sempre responde 200 para o Mercado Pago não ficar reenviando a notificação.
  res.sendStatus(200);
});

// Painel simples de pedidos, protegido por senha (?senha=...).
app.get('/admin/pedidos', async (req, res) => {
  if (!ADMIN_PASSWORD || req.query.senha !== ADMIN_PASSWORD) {
    return res.status(401).send('Senha incorreta. Acesse com ?senha=SUASENHA na URL.');
  }
  if (!pool) return res.status(500).send('Banco de dados não configurado.');

  const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200');
  const linhas = rows.map((o) => `
    <tr>
      <td>${new Date(o.created_at).toLocaleString('pt-BR')}</td>
      <td>${o.status}</td>
      <td>${o.customer_name}<br><small>${o.customer_email} · ${o.customer_phone || ''}</small></td>
      <td>${o.address}, ${o.address_number} ${o.address_complement || ''}<br>${o.neighborhood} - ${o.city}/${o.state}<br>CEP ${o.cep}</td>
      <td>${(o.items || []).map((i) => `${i.quantity}x ${i.title}`).join('<br>')}</td>
      <td>R$ ${Number(o.shipping_cost).toFixed(2)}</td>
      <td>R$ ${Number(o.total).toFixed(2)}</td>
    </tr>
  `).join('');

  res.send(`
    <html><head><meta charset="utf-8"><title>Pedidos - Café Só Grãos</title>
    <style>
      body { font-family: sans-serif; padding: 24px; background: #faf6f0; color: #2a1d14; }
      table { border-collapse: collapse; width: 100%; background: #fff; }
      th, td { border: 1px solid #ecdfc9; padding: 10px; text-align: left; font-size: 14px; vertical-align: top; }
      th { background: #3b2416; color: #fff; }
    </style>
    </head><body>
    <h1>Pedidos — Café Só Grãos</h1>
    <table>
      <tr><th>Data</th><th>Status</th><th>Cliente</th><th>Endereço</th><th>Itens</th><th>Frete</th><th>Total</th></tr>
      ${linhas || '<tr><td colspan="7">Nenhum pedido ainda.</td></tr>'}
    </table>
    </body></html>
  `);
});

app.get('/health', (req, res) => res.json({ ok: true }));

// Rota temporária de diagnóstico: mostra o IP de saída do servidor
// (usada para investigar bloqueio de política do Mercado Pago por IP).
app.get('/whoami', async (req, res) => {
  try {
    const r = await fetch('https://api.ipify.org?format=json');
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao obter IP' });
  }
});

const PORT = process.env.PORT || 3000;
initDb().finally(() => {
  app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
});
