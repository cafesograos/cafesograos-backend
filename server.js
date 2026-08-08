require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Preference } = require('mercadopago');

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

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
