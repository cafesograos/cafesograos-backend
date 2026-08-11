require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const app = express();
app.use(cors());
app.use(express.json());

const ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
const SITE_URL = process.env.SITE_URL || 'https://www.cafesograos.com.br';

if (!ACCESS_TOKEN) {
  console.warn('AVISO: MERCADOPAGO_ACCESS_TOKEN não está definido. Configure o .env antes de aceitar pagamentos.');
}

const client = new MercadoPagoConfig({ accessToken: ACCESS_TOKEN || 'TEST-TOKEN' });

// Cria uma preferência de pagamento a partir dos itens do carrinho
// e devolve o link (init_point) para redirecionar o cliente ao checkout do Mercado Pago.
app.post('/api/create-preference', async (req, res) => {
  try {
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Carrinho vazio ou inválido.' });
    }

    // Validação simples dos itens recebidos do front-end
    const line_items = items.map((item) => ({
      title: String(item.title).slice(0, 250),
      quantity: Math.max(1, parseInt(item.quantity) || 1),
      unit_price: Number(item.unit_price),
      currency_id: 'BRL'
    }));

    const preference = new Preference(client);
    const result = await preference.create({
      body: {
        items: line_items,
        back_urls: {
          success: `${SITE_URL}/sucesso.html`,
          failure: `${SITE_URL}/falha.html`,
          pending: `${SITE_URL}/pendente.html`
        },
        auto_return: 'approved'
      }
    });

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
    } else {
      console.log('Notificação recebida do Mercado Pago:', { topic, id });
    }
  } catch (err) {
    console.error('Erro ao processar notificação do Mercado Pago:', err);
  }
  // Sempre responde 200 para o Mercado Pago não ficar reenviando a notificação.
  res.sendStatus(200);
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
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
