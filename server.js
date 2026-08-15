require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const { pool, initDb } = require('./db');
const { calcularFrete } = require('./shipping');
const { enviarEmailNovoPedido } = require('./email');
const { CATEGORIES, PRODUCTS } = require('./products');

const app = express();
app.set('trust proxy', true); // Railway/Render terminam HTTPS no proxy; sem isso req.protocol vira "http" errado
app.use(cors());
app.use(express.json());

const ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
const SITE_URL = process.env.SITE_URL || 'https://www.cafesograos.com.br';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ACCESS_TOKEN) {
  console.warn('AVISO: MERCADOPAGO_ACCESS_TOKEN não está definido. Configure o .env antes de aceitar pagamentos.');
}

const client = new MercadoPagoConfig({ accessToken: ACCESS_TOKEN || 'TEST-TOKEN' });

// Limita chamadas às rotas que dependem de serviços externos pagos/com limite
// (Melhor Envio) ou que criam registros reais (preferências no Mercado Pago),
// pra um IP não conseguir estourar o limite da conta nem poluir o painel de pedidos.
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em alguns minutos.' }
});

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

// Catálogo de produtos (nome, preço, peso) — fonte única de verdade, usada pelo frontend
// para montar a vitrine e pelo próprio backend para validar o preço de cada pedido.
app.get('/api/produtos', (req, res) => {
  res.json({ categories: CATEGORIES, products: PRODUCTS });
});

// Calcula o frete (Melhor Envio) a partir do CEP de destino e peso total do carrinho (kg).
app.post('/api/calcular-frete', checkoutLimiter, async (req, res) => {
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
app.post('/api/create-preference', checkoutLimiter, async (req, res) => {
  try {
    const { items, cliente, entrega } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Carrinho vazio ou inválido.' });
    }
    if (!cliente?.nome || !cliente?.email || !entrega?.cep) {
      return res.status(400).json({ error: 'Dados de entrega incompletos.' });
    }

    // Preço, nome e peso sempre vêm do catálogo do servidor — nunca do que o
    // cliente mandou — pra ninguém conseguir pagar um valor diferente do real.
    const itensValidados = items.map((item) => {
      const produto = PRODUCTS.find((p) => p.id === item.id);
      if (!produto) throw new Error(`Produto inválido: ${item.id}`);
      return { produto, quantity: Math.min(50, Math.max(1, parseInt(item.quantity) || 1)) };
    });

    const line_items = itensValidados.map(({ produto, quantity }) => ({
      title: produto.nome,
      quantity,
      unit_price: produto.preco,
      currency_id: 'BRL'
    }));

    const pesoTotalKg = itensValidados.reduce(
      (sum, { produto, quantity }) => sum + ((produto.pesoGramas || 300) * quantity) / 1000,
      0
    );
    const freteCalculado = await calcularFrete(entrega.cep, pesoTotalKg);
    const shippingCost = freteCalculado.valor;
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
          JSON.stringify(itensValidados.map(({ produto, quantity }) => ({
            title: produto.nome, quantity, unit_price: produto.preco
          }))),
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

// Dados mínimos e públicos de um pedido (sem nome/e-mail/endereço do cliente),
// usados só pela página de sucesso para registrar a compra no Google Analytics
// com o valor real — só existe pedido aqui se o preference_id realmente existir.
app.get('/api/pedido/:preferenceId', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Banco de dados não configurado.' });
  const { rows } = await pool.query(
    'SELECT status, total, shipping_cost, items FROM orders WHERE preference_id = $1',
    [req.params.preferenceId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Pedido não encontrado.' });
  res.json(rows[0]);
});

// Painel simples de pedidos, protegido por senha (?senha=...).
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

app.get('/admin/pedidos', async (req, res) => {
  if (!ADMIN_PASSWORD || req.query.senha !== ADMIN_PASSWORD) {
    return res.status(401).send('Senha incorreta. Acesse com ?senha=SUASENHA na URL.');
  }
  if (!pool) return res.status(500).send('Banco de dados não configurado.');

  const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200');
  const linhas = rows.map((o) => `
    <tr>
      <td>${escapeHtml(new Date(o.created_at).toLocaleString('pt-BR'))}</td>
      <td>${escapeHtml(o.status)}</td>
      <td>${escapeHtml(o.customer_name)}<br><small>${escapeHtml(o.customer_email)} · ${escapeHtml(o.customer_phone || '')}</small></td>
      <td>${escapeHtml(o.address)}, ${escapeHtml(o.address_number)} ${escapeHtml(o.address_complement || '')}<br>${escapeHtml(o.neighborhood)} - ${escapeHtml(o.city)}/${escapeHtml(o.state)}<br>CEP ${escapeHtml(o.cep)}</td>
      <td>${(o.items || []).map((i) => `${escapeHtml(i.quantity)}x ${escapeHtml(i.title)}`).join('<br>')}</td>
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

// Avaliações de clientes (estilo Google: nome, nota de 1-5, comentário).
// Toda avaliação nova entra como "pending" e só aparece no site depois de
// aprovada manualmente — evita comentário falso de concorrente ou spam.
app.post('/api/avaliacoes', checkoutLimiter, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'Banco de dados não configurado.' });
    const nome = String(req.body?.nome || '').trim().slice(0, 100);
    const nota = Math.round(Number(req.body?.nota));
    const comentario = String(req.body?.comentario || '').trim().slice(0, 600);

    if (!nome || !comentario || !(nota >= 1 && nota <= 5)) {
      return res.status(400).json({ error: 'Preencha nome, nota (1 a 5) e comentário.' });
    }

    await pool.query(
      'INSERT INTO reviews (customer_name, rating, comment) VALUES ($1, $2, $3)',
      [nome, nota, comentario]
    );
    res.json({ ok: true, message: 'Recebemos sua avaliação! Ela vai aparecer no site assim que for revisada.' });
  } catch (err) {
    console.error('Erro ao salvar avaliação:', err);
    res.status(500).json({ error: 'Não foi possível enviar sua avaliação.' });
  }
});

// Avaliações já aprovadas, públicas — usadas na seção "O que dizem sobre a gente".
app.get('/api/avaliacoes', async (req, res) => {
  if (!pool) return res.json([]);
  const { rows } = await pool.query(
    `SELECT customer_name, rating, comment, created_at FROM reviews
     WHERE status = 'approved' ORDER BY created_at DESC LIMIT 30`
  );
  res.json(rows);
});

// Painel de moderação das avaliações, protegido por senha.
app.get('/admin/avaliacoes', async (req, res) => {
  if (!ADMIN_PASSWORD || req.query.senha !== ADMIN_PASSWORD) {
    return res.status(401).send('Senha incorreta. Acesse com ?senha=SUASENHA na URL.');
  }
  if (!pool) return res.status(500).send('Banco de dados não configurado.');

  const { rows } = await pool.query('SELECT * FROM reviews ORDER BY created_at DESC LIMIT 300');
  const senha = encodeURIComponent(req.query.senha);
  const estrelas = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
  const linhas = rows.map((r) => `
    <tr>
      <td>${escapeHtml(new Date(r.created_at).toLocaleString('pt-BR'))}</td>
      <td>${escapeHtml(r.customer_name)}</td>
      <td>${estrelas(r.rating)}</td>
      <td>${escapeHtml(r.comment)}</td>
      <td><strong>${escapeHtml(r.status)}</strong></td>
      <td>
        ${r.status !== 'approved' ? `<a href="/admin/avaliacoes/${r.id}/aprovar?senha=${senha}">Aprovar</a>` : ''}
        ${r.status !== 'approved' && r.status !== 'rejected' ? ' · ' : ''}
        ${r.status !== 'rejected' ? `<a href="/admin/avaliacoes/${r.id}/rejeitar?senha=${senha}">Rejeitar</a>` : ''}
      </td>
    </tr>
  `).join('');

  res.send(`
    <html><head><meta charset="utf-8"><title>Avaliações - Café Só Grãos</title>
    <style>
      body { font-family: sans-serif; padding: 24px; background: #faf6f0; color: #2a1d14; }
      table { border-collapse: collapse; width: 100%; background: #fff; }
      th, td { border: 1px solid #ecdfc9; padding: 10px; text-align: left; font-size: 14px; vertical-align: top; }
      th { background: #3b2416; color: #fff; }
      a { color: #b85a32; }
    </style>
    </head><body>
    <h1>Avaliações — Café Só Grãos</h1>
    <table>
      <tr><th>Data</th><th>Nome</th><th>Nota</th><th>Comentário</th><th>Status</th><th>Ação</th></tr>
      ${linhas || '<tr><td colspan="6">Nenhuma avaliação ainda.</td></tr>'}
    </table>
    </body></html>
  `);
});

app.get('/admin/avaliacoes/:id/:acao', async (req, res) => {
  if (!ADMIN_PASSWORD || req.query.senha !== ADMIN_PASSWORD) {
    return res.status(401).send('Senha incorreta.');
  }
  if (!pool) return res.status(500).send('Banco de dados não configurado.');
  const acao = req.params.acao;
  if (!['aprovar', 'rejeitar'].includes(acao)) return res.status(400).send('Ação inválida.');
  const status = acao === 'aprovar' ? 'approved' : 'rejected';
  await pool.query('UPDATE reviews SET status = $1 WHERE id = $2', [status, req.params.id]);
  res.redirect('/admin/avaliacoes?senha=' + encodeURIComponent(req.query.senha));
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
initDb().finally(() => {
  app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
});
