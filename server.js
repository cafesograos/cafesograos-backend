require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const { pool, initDb } = require('./db');
const { calcularFrete } = require('./shipping');
const { enviarEmailNovoPedido, enviarEmailConfirmacaoCliente, enviarEmailRastreio } = require('./email');
const { CATEGORIES, PRODUCTS } = require('./products');

const app = express();
app.disable('x-powered-by'); // não entrega "Express" de graça pra quem for reconhecer a stack
app.set('trust proxy', true); // Railway/Render terminam HTTPS no proxy; sem isso req.protocol vira "http" errado
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // ícone do painel admin (favicon / apple-touch-icon)

// Headers básicos de segurança — sem CSP (quebraria fontes/scripts
// externos do site sem um mapeamento cuidadoso), mas esses três são de
// baixo risco e fecham golpes comuns (clickjacking, MIME-sniffing).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

const ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
const SITE_URL = process.env.SITE_URL || 'https://www.cafesograos.com.br';
const FRETE_GRATIS_ACIMA_DE = 300;
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

// O /webhook do Mercado Pago não tinha limite nenhum — qualquer um podia
// bombardear a rota, cada chamada gerando uma consulta na API do Mercado
// Pago. Esse limite é mais folgado que o checkoutLimiter pois o MP às vezes
// reenvia a mesma notificação várias vezes.
const webhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  standardHeaders: true,
  legacyHeaders: false
});

// Trava bruteforce de senha nas rotas /admin* — a senha é forte, mas sem
// limite alguém poderia tentar milhares de valores por script.
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Muitas tentativas. Tente novamente em alguns minutos.'
});
app.use('/admin', adminLimiter);

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
// Se o subtotal do carrinho já bater o mínimo do frete grátis, zera o valor
// (mas mantém o prazo real) — mesma regra aplicada de novo, com autoridade,
// em /api/create-preference na hora de fechar o pedido.
app.post('/api/calcular-frete', checkoutLimiter, async (req, res) => {
  try {
    const { cep, pesoKg, subtotal } = req.body;
    const frete = await calcularFrete(cep, Number(pesoKg));
    if (Number(subtotal) >= FRETE_GRATIS_ACIMA_DE) {
      frete.valor = 0;
      frete.gratis = true;
    }
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

    if (!Array.isArray(items) || items.length === 0 || items.length > 30) {
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

    // Detecta se é a primeira compra aprovada dessa pessoa (por e-mail, telefone
    // ou endereço+número — nome sozinho não conta, é fácil demais de repetir e
    // nomes comuns colidem entre clientes diferentes). Se não for a primeira,
    // busca um cupom de 5% ainda válido, ganho na compra anterior.
    let freeGift = false;
    let desconto = null;
    if (pool) {
      const { rows: existentes } = await pool.query(
        `SELECT 1 FROM orders WHERE status = 'approved' AND (
           LOWER(TRIM(customer_email)) = LOWER(TRIM($1))
           OR customer_phone = $2
           OR (LOWER(TRIM(address)) = LOWER(TRIM($3)) AND LOWER(TRIM(address_number)) = LOWER(TRIM($4)))
         ) LIMIT 1`,
        [cliente.email, cliente.telefone || '', entrega.endereco, entrega.numero]
      );
      if (existentes.length === 0) {
        freeGift = true;
      } else {
        const { rows: cupons } = await pool.query(
          `SELECT * FROM discounts WHERE LOWER(TRIM(customer_email)) = LOWER(TRIM($1))
           AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
          [cliente.email]
        );
        desconto = cupons[0] || null;
      }
    }

    const descontoPercent = desconto ? Number(desconto.percent) : 0;
    const itensParaPedido = itensValidados.map(({ produto, quantity }) => ({
      title: produto.nome,
      quantity,
      unit_price: descontoPercent > 0
        ? Number((produto.preco * (1 - descontoPercent / 100)).toFixed(2))
        : produto.preco
    }));

    // Brinde de boas-vindas: um Drip Coffee grátis (item de R$0, aparece de
    // verdade no pedido) na primeira compra aprovada de cada pessoa.
    let brindeProduto = null;
    if (freeGift) {
      brindeProduto = PRODUCTS.find((p) => p.id === 'drip-coffee-caixa-10');
      if (brindeProduto) {
        itensParaPedido.push({ title: `${brindeProduto.nome} — Brinde de boas-vindas`, quantity: 1, unit_price: 0 });
      }
    }

    const line_items = itensParaPedido.map((i) => ({ ...i, currency_id: 'BRL' }));

    // Subtotal pelo preço de catálogo (sem desconto) — é o que decide se bateu
    // o valor mínimo do frete grátis, não o valor já com cupom aplicado.
    const subtotalCatalogo = itensValidados.reduce((sum, { produto, quantity }) => sum + produto.preco * quantity, 0);

    let pesoTotalKg = itensValidados.reduce(
      (sum, { produto, quantity }) => sum + ((produto.pesoGramas || 300) * quantity) / 1000,
      0
    );
    if (brindeProduto) pesoTotalKg += (brindeProduto.pesoGramas || 400) / 1000;

    let shippingCost = 0;
    if (subtotalCatalogo < FRETE_GRATIS_ACIMA_DE) {
      const freteCalculado = await calcularFrete(entrega.cep, pesoTotalKg);
      shippingCost = freteCalculado.valor;
    }
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
          (preference_id, status, customer_name, customer_email, customer_phone, cep, address, address_number, address_complement, neighborhood, city, state, items, shipping_cost, total, free_gift, discount_id, discount_percent)
         VALUES ($1,'pending',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
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
          JSON.stringify(itensParaPedido),
          shippingCost,
          total,
          freeGift,
          desconto ? desconto.id : null,
          desconto ? desconto.percent : null
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
app.all('/webhook', webhookLimiter, async (req, res) => {
  try {
    const topic = req.query.topic || req.query.type || req.body?.type;
    const id = req.query.id || req.body?.data?.id;

    if (topic === 'payment' && id) {
      const payment = new Payment(client);
      const info = await payment.get({ id });
      console.log(`Notificação de pagamento ${id}: status "${info.status}"`);

      // A API de pagamentos não devolve mais preference_id direto (só o id
      // da merchant_order) — sem isso a gente nunca conseguia casar o
      // pagamento com o pedido, e o status ficava pending pra sempre mesmo
      // com o pagamento aprovado.
      let preferenceId = info.preference_id;
      if (!preferenceId && info.order?.id) {
        const orderRes = await fetch(`https://api.mercadopago.com/merchant_orders/${info.order.id}`, {
          headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
        });
        if (orderRes.ok) {
          preferenceId = (await orderRes.json()).preference_id;
        }
      }

      if (pool && preferenceId) {
        const { rows } = await pool.query(
          `UPDATE orders SET status = $1, payment_id = $2 WHERE preference_id = $3 RETURNING *`,
          [info.status, String(id), preferenceId]
        );
        const order = rows[0];
        if (order && info.status === 'approved') {
          // Só cria o cupom/marca como usado quando o pagamento é realmente
          // aprovado — evita gerar cupom pra carrinho abandonado ou queimar
          // o cupom de alguém que desistiu no meio do checkout.
          if (order.free_gift) {
            const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
            await pool.query(
              'INSERT INTO discounts (customer_email, percent, expires_at) VALUES ($1, 5, $2)',
              [order.customer_email, expiresAt]
            );
          }
          if (order.discount_id) {
            await pool.query('UPDATE discounts SET used_at = now() WHERE id = $1', [order.discount_id]);
          }

          await enviarEmailNovoPedido(order);
          await enviarEmailConfirmacaoCliente(order);
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
// usados pela página de sucesso (registrar compra no Google Analytics) e pela
// página de rastreio (cliente consulta status/código com o número do pedido,
// que é o preference_id — o mesmo enviado no e-mail de confirmação).
app.get('/api/pedido/:preferenceId', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Banco de dados não configurado.' });
  const { rows } = await pool.query(
    'SELECT status, total, shipping_cost, items, tracking_code, created_at FROM orders WHERE preference_id = $1',
    [req.params.preferenceId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Pedido não encontrado.' });
  res.json(rows[0]);
});

// Painéis administrativos, todos protegidos pela mesma senha (?senha=...).
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD || req.query.senha !== ADMIN_PASSWORD) {
    return res.status(401).send('Senha incorreta. Acesse com ?senha=SUASENHA na URL.');
  }
  next();
}

// Layout compartilhado pelos painéis: mesma barra de navegação em todos,
// pra dar pra pular entre pedidos, avaliações, métricas, GA e Mercado Pago
// sem digitar URL de novo.
function adminLayout({ title, senha, ativo, body }) {
  const nav = [
    { id: 'painel', label: 'Painel', href: `/admin?senha=${senha}` },
    { id: 'pedidos', label: 'Pedidos', href: `/admin/pedidos?senha=${senha}` },
    { id: 'avaliacoes', label: 'Avaliações', href: `/admin/avaliacoes?senha=${senha}` },
    { id: 'ga', label: 'Google Analytics ↗', href: 'https://analytics.google.com/analytics/web/', external: true },
    { id: 'mp', label: 'Mercado Pago ↗', href: 'https://www.mercadopago.com.br/activities', external: true }
  ];
  const navHtml = nav.map((item) => `
    <a href="${item.href}" ${item.external ? 'target="_blank" rel="noopener noreferrer"' : ''} class="${item.id === ativo ? 'ativo' : ''}">${item.label}</a>
  `).join('');

  return `
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)} - Café Só Grãos</title>
    <link rel="icon" href="/favicon.ico" sizes="any">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png">
    <meta name="theme-color" content="#211714">
    <meta name="referrer" content="no-referrer">
    <style>
      body { font-family: sans-serif; padding: 0; margin: 0; background: #faf6f0; color: #2a1d14; }
      .admin-nav { background: #3b2416; padding: 12px 16px; display: flex; gap: 14px; flex-wrap: wrap; }
      .admin-nav a { color: rgba(255,255,255,.75); text-decoration: none; font-size: 14px; font-weight: 600; white-space: nowrap; }
      .admin-nav a:hover, .admin-nav a.ativo { color: #fff; }
      .admin-body { padding: 16px; }
      h1 { margin-top: 0; font-size: 22px; }
      table { border-collapse: collapse; width: 100%; background: #fff; display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; }
      th, td { border: 1px solid #ecdfc9; padding: 10px; text-align: left; font-size: 14px; vertical-align: top; }
      th { background: #3b2416; color: #fff; }
      a { color: #b85a32; }
      form { margin-top: 6px; }
      .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 28px; }
      .card { background: #fff; border: 1px solid #ecdfc9; border-radius: 8px; padding: 16px; }
      .card span { display: block; font-size: 13px; color: #8a6f5c; margin-bottom: 6px; }
      .card strong { font-size: 22px; }
      .card.alerta strong { color: #b85a32; }
      section { margin-bottom: 32px; }
      section h2 { font-size: 16px; margin-bottom: 12px; }
      @media (max-width: 480px) {
        .admin-body { padding: 12px; }
        .cards { grid-template-columns: 1fr 1fr; }
        th, td { font-size: 13px; padding: 8px; }
      }
    </style>
    </head><body>
    <nav class="admin-nav">${navHtml}</nav>
    <div class="admin-body">${body}</div>
    </body></html>
  `;
}

// Painel geral: vendas, pendências e produtos mais vendidos, com atalhos
// pros outros painéis e pro Google Analytics / Mercado Pago.
app.get('/admin', requireAdmin, async (req, res) => {
  if (!pool) return res.status(500).send('Banco de dados não configurado.');
  const senha = encodeURIComponent(req.query.senha);

  const [hoje, semana, mes, statusRows, semRastreioRows, avaliacoesPendentesRows, topProdutosRows] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(total),0) AS total FROM orders WHERE status='approved' AND created_at >= date_trunc('day', now())`),
    pool.query(`SELECT COALESCE(SUM(total),0) AS total FROM orders WHERE status='approved' AND created_at >= date_trunc('week', now())`),
    pool.query(`SELECT COALESCE(SUM(total),0) AS total FROM orders WHERE status='approved' AND created_at >= date_trunc('month', now())`),
    pool.query(`SELECT status, COUNT(*) AS n FROM orders GROUP BY status ORDER BY n DESC`),
    pool.query(`SELECT COUNT(*) AS n FROM orders WHERE status='approved' AND (tracking_code IS NULL OR tracking_code = '')`),
    pool.query(`SELECT COUNT(*) AS n FROM reviews WHERE status='pending'`),
    pool.query(`
      SELECT item->>'title' AS titulo, SUM((item->>'quantity')::int) AS qtd
      FROM orders, jsonb_array_elements(items) AS item
      WHERE status = 'approved'
      GROUP BY titulo
      ORDER BY qtd DESC
      LIMIT 5
    `)
  ]);

  const reais = (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ',');
  const statusLabel = { pending: 'Pendente', approved: 'Aprovado', rejected: 'Recusado', in_process: 'Em análise', cancelled: 'Cancelado', refunded: 'Reembolsado' };
  const semRastreio = Number(semRastreioRows.rows[0].n);
  const avaliacoesPendentes = Number(avaliacoesPendentesRows.rows[0].n);

  const body = `
    <h1>Painel — Café Só Grãos</h1>

    <section>
      <h2>Vendas (pedidos aprovados)</h2>
      <div class="cards">
        <div class="card"><span>Hoje</span><strong>${reais(hoje.rows[0].total)}</strong></div>
        <div class="card"><span>Esta semana</span><strong>${reais(semana.rows[0].total)}</strong></div>
        <div class="card"><span>Este mês</span><strong>${reais(mes.rows[0].total)}</strong></div>
      </div>
    </section>

    <section>
      <h2>Pendências</h2>
      <div class="cards">
        <div class="card ${semRastreio > 0 ? 'alerta' : ''}">
          <span>Pedidos sem rastreio</span><strong>${semRastreio}</strong>
          <a href="/admin/pedidos?senha=${senha}">Ver pedidos →</a>
        </div>
        <div class="card ${avaliacoesPendentes > 0 ? 'alerta' : ''}">
          <span>Avaliações aguardando aprovação</span><strong>${avaliacoesPendentes}</strong>
          <a href="/admin/avaliacoes?senha=${senha}">Ver avaliações →</a>
        </div>
      </div>
    </section>

    <section>
      <h2>Produtos mais vendidos</h2>
      <table>
        <tr><th>Produto</th><th>Unidades vendidas</th></tr>
        ${topProdutosRows.rows.map((p) => `<tr><td>${escapeHtml(p.titulo)}</td><td>${p.qtd}</td></tr>`).join('') || '<tr><td colspan="2">Ainda sem vendas aprovadas.</td></tr>'}
      </table>
    </section>

    <section>
      <h2>Pedidos por status</h2>
      <table>
        <tr><th>Status</th><th>Quantidade</th></tr>
        ${statusRows.rows.map((s) => `<tr><td>${escapeHtml(statusLabel[s.status] || s.status)}</td><td>${s.n}</td></tr>`).join('') || '<tr><td colspan="2">Nenhum pedido ainda.</td></tr>'}
      </table>
    </section>
  `;

  res.send(adminLayout({ title: 'Painel', senha, ativo: 'painel', body }));
});

app.get('/admin/pedidos', requireAdmin, async (req, res) => {
  if (!pool) return res.status(500).send('Banco de dados não configurado.');

  const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200');
  const senha = encodeURIComponent(req.query.senha);
  const linhas = rows.map((o) => `
    <tr>
      <td>${escapeHtml(new Date(o.created_at).toLocaleString('pt-BR'))}</td>
      <td>${escapeHtml(o.status)}${o.free_gift ? '<br>🎁 brinde' : ''}${o.discount_percent ? `<br>-${escapeHtml(o.discount_percent)}%` : ''}</td>
      <td>${escapeHtml(o.customer_name)}<br><small>${escapeHtml(o.customer_email)} · ${escapeHtml(o.customer_phone || '')}</small></td>
      <td>${escapeHtml(o.address)}, ${escapeHtml(o.address_number)} ${escapeHtml(o.address_complement || '')}<br>${escapeHtml(o.neighborhood)} - ${escapeHtml(o.city)}/${escapeHtml(o.state)}<br>CEP ${escapeHtml(o.cep)}</td>
      <td>${(o.items || []).map((i) => `${escapeHtml(i.quantity)}x ${escapeHtml(i.title)}`).join('<br>')}</td>
      <td>${Number(o.shipping_cost) === 0 ? 'Grátis' : 'R$ ' + Number(o.shipping_cost).toFixed(2)}</td>
      <td>R$ ${Number(o.total).toFixed(2)}</td>
      <td>
        ${o.tracking_code ? `Enviado:<br><strong>${escapeHtml(o.tracking_code)}</strong>` : ''}
        <form method="POST" action="/admin/pedidos/${o.id}/rastreio?senha=${senha}">
          <input type="text" name="codigo" placeholder="Código de rastreio" value="${escapeHtml(o.tracking_code || '')}" style="width:130px;">
          <button type="submit">${o.tracking_code ? 'Reenviar e-mail' : 'Marcar enviado'}</button>
        </form>
      </td>
      <td>
        <form method="POST" action="/admin/pedidos/${o.id}/excluir?senha=${senha}" onsubmit="return confirm('Excluir este pedido de ${escapeHtml(o.customer_name)}? Não tem como desfazer.');">
          <button type="submit" style="color:#b91c1c;">Excluir</button>
        </form>
      </td>
    </tr>
  `).join('');

  const body = `
    <h1>Pedidos — Café Só Grãos</h1>
    <table>
      <tr><th>Data</th><th>Status</th><th>Cliente</th><th>Endereço</th><th>Itens</th><th>Frete</th><th>Total</th><th>Rastreio</th><th></th></tr>
      ${linhas || '<tr><td colspan="9">Nenhum pedido ainda.</td></tr>'}
    </table>
  `;
  res.send(adminLayout({ title: 'Pedidos', senha, ativo: 'pedidos', body }));
});

// Salva o código de rastreio de um pedido e avisa o cliente por e-mail.
app.post('/admin/pedidos/:id/rastreio', requireAdmin, express.urlencoded({ extended: false }), async (req, res) => {
  if (!pool) return res.status(500).send('Banco de dados não configurado.');

  const codigo = String(req.body?.codigo || '').trim().slice(0, 100);
  if (!codigo) return res.status(400).send('Informe um código de rastreio.');

  const { rows } = await pool.query(
    'UPDATE orders SET tracking_code = $1 WHERE id = $2 RETURNING *',
    [codigo, req.params.id]
  );
  const order = rows[0];
  if (order) await enviarEmailRastreio(order);

  res.redirect('/admin/pedidos?senha=' + encodeURIComponent(req.query.senha));
});

// Exclui um pedido (ex.: pedidos de teste feitos durante o desenvolvimento).
app.post('/admin/pedidos/:id/excluir', requireAdmin, async (req, res) => {
  if (!pool) return res.status(500).send('Banco de dados não configurado.');

  await pool.query('DELETE FROM orders WHERE id = $1', [req.params.id]);

  res.redirect('/admin/pedidos?senha=' + encodeURIComponent(req.query.senha));
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
app.get('/admin/avaliacoes', requireAdmin, async (req, res) => {
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

  const body = `
    <h1>Avaliações — Café Só Grãos</h1>
    <table>
      <tr><th>Data</th><th>Nome</th><th>Nota</th><th>Comentário</th><th>Status</th><th>Ação</th></tr>
      ${linhas || '<tr><td colspan="6">Nenhuma avaliação ainda.</td></tr>'}
    </table>
  `;
  res.send(adminLayout({ title: 'Avaliações', senha, ativo: 'avaliacoes', body }));
});

app.get('/admin/avaliacoes/:id/:acao', requireAdmin, async (req, res) => {
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
