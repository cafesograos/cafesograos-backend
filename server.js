require('./instrument');
require('dotenv').config();
const Sentry = require('@sentry/node');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { pool, initDb } = require('./db');
const { calcularFrete, inserirNoCarrinho, comprarEtiquetas, gerarEtiquetas, imprimirEtiquetas, rastrearEtiquetas } = require('./shipping');
const { criarLinkPagamento, consultarStatusPagamento } = require('./infinitepay');
const { enviarEmailNovoPedido, enviarEmailConfirmacaoCliente, enviarEmailRastreio, enviarEmailBoasVindasLead } = require('./email');
const { CATEGORIES, PRODUCTS } = require('./products');
const { agendarBackupDiario } = require('./backup');

const app = express();
app.disable('x-powered-by'); // não entrega "Express" de graça pra quem for reconhecer a stack
app.set('trust proxy', 1); // Railway/Render terminam HTTPS num único proxy; "true" confiaria em qualquer X-Forwarded-For e quebra o rate limit por IP

// CORS aberto (sem origin definida) deixava qualquer site na internet chamar
// nossa API — inclusive /api/create-preference, que cria pedido de verdade
// na InfinitePay. Restringe só ao próprio site (+ o domínio do próprio painel
// admin, que roda aqui no backend, + localhost, usado em testes).
// Importante: nunca chamar o callback com Error — isso derruba a requisição
// inteira com 500 (inclusive submits de formulário same-origin, que nem
// passam por CORS de verdade). callback(null, false) só omite o cabeçalho,
// que é o suficiente pra bloquear leitura via JS de outra origem.
const ORIGENS_PERMITIDAS = [
  'https://cafesograos.com.br',
  'https://www.cafesograos.com.br',
  'https://cafesograos-backend-production.up.railway.app',
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/
];
app.use(cors({
  origin(origin, callback) {
    const permitido = !origin || ORIGENS_PERMITIDAS.some((o) => (o instanceof RegExp ? o.test(origin) : o === origin));
    callback(null, permitido);
  }
}));
app.use(express.json());
app.use(express.static('public')); // ícone do painel admin (favicon / apple-touch-icon)

// CSP mapeada só pro que o painel admin realmente usa: estilo inline (todo
// <style> do layout), onclick inline (script-src-attr, nunca script-src —
// assim uma injeção de <script> continua bloqueada mesmo com os onclick
// existentes liberados) e a fonte do Fontshare (CSS em api., arquivos em
// cdn.). Sem isso o painel quebraria (fonte some, botão de refresh para
// de funcionar); com isso, uma injeção de HTML/JS externo continua bloqueada.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "script-src-attr 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://api.fontshare.com",
  "font-src 'self' https://cdn.fontshare.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'"
].join('; ');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // Header (não meta tag) pra cobrir TODA resposta desde a primeira requisição —
  // inclusive o CSS do Fontshare carregado no <head> do painel admin antes de
  // qualquer <meta> ser processada, que senão sairia com a URL completa (com
  // ?senha=...) no Referer pro CDN de fontes.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  next();
});

const SITE_URL = process.env.SITE_URL || 'https://www.cafesograos.com.br';
const FRETE_GRATIS_ACIMA_DE = 300;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// Frete grátis acima do valor mínimo vale só pra São Paulo — a faixa de CEP
// do estado (01000-000 a 19999-999) é fixa e pública, não precisa de consulta
// externa. Calculado no servidor (nunca a partir do que o cliente informa)
// pra ninguém conseguir digitar um estado falso e ganhar frete grátis fora de SP.
function cepEhSP(cep) {
  const digitos = String(cep || '').replace(/\D/g, '');
  if (digitos.length < 5) return false;
  const prefixo = Number(digitos.slice(0, 5));
  return prefixo >= 1000 && prefixo <= 19999;
}

// Limita a rota que cria pagamento de verdade (InfinitePay) — mais apertado
// porque cada chamada gera um pedido real no banco, pra um IP não conseguir
// poluir o painel de pedidos nem abusar da criação de links de pagamento.
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em alguns minutos.' }
});

// Calcular frete (Melhor Envio) é só consulta, sem custo nem registro criado —
// mais generoso que o checkout porque é normal testar vários CEPs/quantidades
// antes de fechar o pedido. Tinha o mesmo limite apertado do checkout antes,
// e um cliente testando frete algumas vezes já esgotava a cota de quem for
// finalizar a compra depois, no mesmo IP.
const freteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em alguns minutos.' }
});

// Avaliação e newsletter só gravam no nosso próprio banco (sem custo de API
// externa) — não tem por que competir pelo mesmo limite apertado do checkout.
const formularioLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em alguns minutos.' }
});

// Webhook da InfinitePay — mais folgado que o checkoutLimiter porque o
// provedor pode reenviar a mesma notificação várias vezes, e cada chamada
// gera uma consulta de confirmação na API deles.
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
// Antes essas duas rotas eram públicas, sem checagem nenhuma — qualquer um
// que descobrisse a URL podia completar o fluxo OAuth com a PRÓPRIA conta do
// Melhor Envio e substituir silenciosamente a integração do Alberto pela
// dele. Agora /connect exige a senha do admin, e o /callback só aceita um
// "state" que a gente mesmo gerou nessa sessão (proteção padrão de CSRF em
// OAuth) — nunca aceita um code vindo de fora desse fluxo.
let melhorEnvioOAuthState = null;
app.get('/oauth/melhorenvio/connect', requireAdmin, (req, res) => {
  melhorEnvioOAuthState = crypto.randomBytes(24).toString('hex');
  const redirectUri = `${req.protocol}://${req.get('host')}/oauth/melhorenvio/callback`;
  const url = new URL('https://melhorenvio.com.br/oauth/authorize');
  url.searchParams.set('client_id', process.env.MELHORENVIO_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  // "shipping-calculate" sozinho só autorizava cotar frete — a automação de
  // etiqueta (carrinho, pagamento, geração, impressão, rastreio) dava "This
  // action is unauthorized" por falta desses escopos extras. Precisa
  // reautorizar (rodar /oauth/melhorenvio/connect de novo) depois desse
  // deploy pra pegar um token com o escopo novo.
  url.searchParams.set('scope', 'shipping-calculate shipping-companies cart-read cart-write shipping-checkout shipping-generate shipping-print shipping-tracking');
  url.searchParams.set('state', melhorEnvioOAuthState);
  res.redirect(url.toString());
});

app.get('/oauth/melhorenvio/callback', async (req, res) => {
  try {
    if (!melhorEnvioOAuthState || req.query.state !== melhorEnvioOAuthState) {
      return res.status(403).send('Autorização inválida ou expirada. Peça pro admin iniciar a conexão de novo.');
    }
    melhorEnvioOAuthState = null; // uso único
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
// Bloqueia só essa rota (não o site todo) pra clientes que se identificam
// como "curl" — nenhum navegador de verdade manda esse User-Agent, só
// scripts. Depois do bloqueio por IP ter saído errado (o IP aparecia na
// cadeia de proxy de toda requisição vinda da mesma região da Railway,
// não só do script), isso fica restrito a essa rota específica de propósito,
// pra nunca mais arriscar derrubar o site inteiro por engano.
function pareceScript(req) {
  return /^curl\//i.test(String(req.headers['user-agent'] || ''));
}

// Bloqueia ANTES do rate limiter (não depois) — o script insistiu tanto que
// sozinho esgotava a cota de 15 min, e como o IP dele aparentemente é
// compartilhado (CGNAT da operadora regional) com clientes de verdade
// tentando calcular frete de verdade, isso derrubava o cálculo de frete pra
// gente real na mesma faixa de IP. Bloqueando antes do freteLimiter, o
// script nunca chega a consumir a cota de quem é de verdade.
function bloquearScript(req, res, next) {
  if (pareceScript(req)) {
    console.warn(`[bloqueado] User-Agent de script em /api/calcular-frete: "${req.headers['user-agent']}"`);
    return res.status(403).json({ error: 'Acesso bloqueado.' });
  }
  next();
}

app.post('/api/calcular-frete', bloquearScript, freteLimiter, async (req, res) => {
  try {
    const { cep, pesoKg, subtotal } = req.body;
    const frete = await calcularFrete(cep, Number(pesoKg));
    if (Number(subtotal) >= FRETE_GRATIS_ACIMA_DE && cepEhSP(cep)) {
      frete.valor = 0;
      frete.gratis = true;
    }
    res.json(frete);
  } catch (err) {
    console.error('Erro ao calcular frete:', err.message);
    res.status(400).json({ error: 'Não foi possível calcular o frete. Confira o CEP.' });
  }
});

// Validação padrão de CPF (dígitos verificadores) — recusa também sequências
// óbvias tipo "00000000000". Garante um documento de verdade antes de
// salvar: é o CPF do destinatário que a Melhor Envio exige pra emitir a
// etiqueta de envio depois.
function cpfValido(cpf) {
  cpf = String(cpf || '').replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  let soma = 0;
  for (let i = 0; i < 9; i++) soma += parseInt(cpf[i], 10) * (10 - i);
  let resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  if (resto !== parseInt(cpf[9], 10)) return false;
  soma = 0;
  for (let i = 0; i < 10; i++) soma += parseInt(cpf[i], 10) * (11 - i);
  resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  return resto === parseInt(cpf[10], 10);
}

// Cria um link de pagamento a partir dos itens do carrinho + dados de entrega,
// salva o pedido no banco e devolve o link (init_point) para o checkout da InfinitePay.
app.post('/api/create-preference', checkoutLimiter, async (req, res) => {
  try {
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0 || items.length > 30) {
      return res.status(400).json({ error: 'Carrinho vazio ou inválido.' });
    }
    // Corta e limpa espaço de todo texto vindo do cliente antes de usar em
    // qualquer lugar (banco, e-mail, painel) — sem isso, nome/endereço sem
    // limite de tamanho (diferente do formulário de avaliação/newsletter,
    // que já limitavam) podia sujar o banco e quebrar layout de e-mail/painel
    // com um valor absurdamente grande.
    const cliente = {
      nome: String(req.body?.cliente?.nome || '').trim().slice(0, 100),
      email: String(req.body?.cliente?.email || '').trim().slice(0, 200),
      telefone: String(req.body?.cliente?.telefone || '').trim().slice(0, 30),
      cpf: req.body?.cliente?.cpf
    };
    const entrega = {
      cep: req.body?.entrega?.cep,
      endereco: String(req.body?.entrega?.endereco || '').trim().slice(0, 200),
      numero: String(req.body?.entrega?.numero || '').trim().slice(0, 20),
      complemento: String(req.body?.entrega?.complemento || '').trim().slice(0, 100),
      bairro: String(req.body?.entrega?.bairro || '').trim().slice(0, 100),
      cidade: String(req.body?.entrega?.cidade || '').trim().slice(0, 100),
      estado: String(req.body?.entrega?.estado || '').trim().slice(0, 2).toUpperCase()
    };
    if (!cliente.nome || !cliente.email || !entrega.cep) {
      return res.status(400).json({ error: 'Dados de entrega incompletos.' });
    }
    // Sem essa checagem, um e-mail sem ponto no domínio (ex.: "nome@gmailcom",
    // digitado errado) passava batido — o pagamento era aprovado normalmente,
    // mas o Resend rejeitava o envio da confirmação/rastreio, e o cliente
    // nunca ficava sabendo de nada sobre o próprio pedido.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cliente.email)) {
      return res.status(400).json({ error: 'E-mail inválido.' });
    }
    const cpfDigits = String(cliente.cpf || '').replace(/\D/g, '');
    if (!cpfValido(cpfDigits)) {
      return res.status(400).json({ error: 'CPF inválido.' });
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
    // verdade no pedido) na primeira compra aprovada de cada pessoa. Quem se
    // cadastrou antes no popup de entrada do site (telefone bate com um
    // cadastro em "leads" marcado cadastro_popup) ganha 2 em vez de 1 — só
    // vale pra primeira compra também, igual ao brinde normal.
    let brindeProduto = null;
    let brindeQuantidade = 0;
    if (freeGift) {
      brindeQuantidade = 1;
      const telefoneDigitsCadastro = String(cliente.telefone || '').replace(/\D/g, '');
      if (pool && telefoneDigitsCadastro.length >= 10) {
        const { rows: cadastroPopup } = await pool.query(
          `SELECT 1 FROM leads WHERE cadastro_popup = true AND regexp_replace(phone, '\\D', '', 'g') = $1 LIMIT 1`,
          [telefoneDigitsCadastro]
        );
        if (cadastroPopup.length > 0) brindeQuantidade = 2;
      }
      brindeProduto = PRODUCTS.find((p) => p.id === 'drip-coffee-caixa-10');
      if (brindeProduto) {
        const sufixoBrinde = brindeQuantidade > 1 ? ` — Brinde de boas-vindas (cadastro antecipado)` : ' — Brinde de boas-vindas';
        itensParaPedido.push({ title: `${brindeProduto.nome}${sufixoBrinde}`, quantity: brindeQuantidade, unit_price: 0 });
      } else {
        // Sem isso, se o id do brinde mudar no catálogo, o brinde de boas-vindas
        // some silenciosamente pro cliente novo, sem erro nenhum aparecer.
        console.warn('[pedido] Produto de brinde "drip-coffee-caixa-10" não encontrado no catálogo — brinde de boas-vindas não foi incluído.');
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
    if (brindeProduto) pesoTotalKg += ((brindeProduto.pesoGramas || 400) * brindeQuantidade) / 1000;

    // Sempre cotamos, mesmo quando o frete grátis vai zerar o valor cobrado do
    // cliente — o pacote ainda precisa ser enviado por alguma transportadora
    // de verdade, e sem cotar aqui não sobrava id de serviço nenhum pra
    // comprar a etiqueta desses pedidos depois.
    const freteGratis = subtotalCatalogo >= FRETE_GRATIS_ACIMA_DE && cepEhSP(entrega.cep);
    const freteCalculado = await calcularFrete(entrega.cep, pesoTotalKg);
    const shippingCost = freteGratis ? 0 : freteCalculado.valor;
    // Guarda qual transportadora/modalidade foi a mais barata pra esse pedido
    // — sem isso, na hora de gerar a etiqueta de verdade era preciso
    // recalcular o frete manualmente só pra descobrir qual usar.
    const shippingCarrier = freteCalculado.transportadora || null;
    const shippingServiceId = freteCalculado.servicoId || null;
    if (shippingCost > 0) {
      line_items.push({
        title: 'Frete',
        quantity: 1,
        unit_price: shippingCost,
        currency_id: 'BRL'
      });
    }

    const total = Number(line_items.reduce((sum, i) => sum + i.unit_price * i.quantity, 0).toFixed(2));

    const telefoneDigits = String(cliente.telefone || '').replace(/\D/g, '');
    const customer = { name: cliente.nome, email: cliente.email };
    if (telefoneDigits.length >= 10) customer.phone_number = '+55' + telefoneDigits;

    // Identificador do pedido gerado por nós (a InfinitePay não devolve um id
    // próprio na criação do link) — é com ele que casamos webhook e o pedido
    // salvo no banco, no lugar do preference_id que vinha do Mercado Pago.
    const orderNsu = crypto.randomUUID();

    // A InfinitePay rejeita item com valor 0 — o brinde de boas-vindas (R$0)
    // continua registrado no pedido/e-mail normalmente, só não vai como linha
    // separada no link de pagamento (não muda o valor cobrado de qualquer forma).
    const itensParaPagamento = line_items.filter((i) => i.unit_price > 0);

    const initPoint = await criarLinkPagamento({
      items: itensParaPagamento,
      customer,
      address: {
        cep: String(entrega.cep || '').replace(/\D/g, ''),
        street: entrega.endereco,
        neighborhood: entrega.bairro,
        number: entrega.numero,
        complement: entrega.complemento || undefined
      },
      orderNsu,
      redirectUrl: `${SITE_URL}/sucesso.html`,
      webhookUrl: `${req.protocol}://${req.get('host')}/webhook-infinitepay`
    });

    if (pool) {
      await pool.query(
        `INSERT INTO orders
          (preference_id, status, customer_name, customer_email, customer_phone, customer_cpf, cep, address, address_number, address_complement, neighborhood, city, state, items, shipping_cost, shipping_carrier, shipping_service_id, shipping_weight_kg, total, free_gift, discount_id, discount_percent)
         VALUES ($1,'pending',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
        [
          orderNsu,
          cliente.nome,
          cliente.email,
          cliente.telefone || null,
          cpfDigits,
          entrega.cep,
          entrega.endereco,
          entrega.numero,
          entrega.complemento || null,
          entrega.bairro,
          entrega.cidade,
          entrega.estado,
          JSON.stringify(itensParaPedido),
          shippingCost,
          shippingCarrier,
          shippingServiceId,
          Number(pesoTotalKg.toFixed(3)),
          total,
          freeGift,
          desconto ? desconto.id : null,
          desconto ? desconto.percent : null
        ]
      );
    }

    res.json({ init_point: initPoint });
  } catch (err) {
    console.error('Erro ao criar link de pagamento:', err);
    res.status(500).json({ error: 'Erro ao criar pagamento.' });
  }
});

// Atualiza o status de um pedido a partir da confirmação de pagamento da
// InfinitePay — centralizado aqui pra nunca duplicar a lógica de cupom/e-mail
// (e nunca duplicar o cupom em si).
async function atualizarStatusPedido(preferenceId, novoStatus, paymentId) {
  if (!pool || !preferenceId) return null;

  // Guarda o status de antes pra só disparar cupom/e-mails na primeira vez
  // que o pedido vira "approved" — o provedor pode reenviar a mesma
  // notificação várias vezes, e sem essa checagem cada reenvio gerava um
  // cupom duplicado e mandava os e-mails de novo.
  const { rows: antes } = await pool.query('SELECT status FROM orders WHERE preference_id = $1', [preferenceId]);
  if (!antes[0]) return null;
  const statusAnterior = antes[0].status;

  const { rows } = await pool.query(
    `UPDATE orders SET status = $1, payment_id = $2 WHERE preference_id = $3 RETURNING *`,
    [novoStatus, String(paymentId), preferenceId]
  );
  const order = rows[0];
  if (order && novoStatus === 'approved' && statusAnterior !== 'approved') {
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

    // O pedido já está aprovado e o cupom já foi gerado/queimado nesse ponto —
    // uma falha ao enviar e-mail (ex.: soluço de rede até o Resend) não pode
    // mais derrubar isso nem fazer o webhook responder erro pra InfinitePay
    // reenviar depois: como o pedido já está "approved", o reenvio cairia na
    // checagem de statusAnterior acima e nunca tentaria o e-mail de novo —
    // ou seja, sem isso, uma falha nessa hora ficava permanente e silenciosa.
    // Cada e-mail é isolado (um falhar não impede o outro) e vai pro Sentry
    // pra aparecer no monitoramento em vez de sumir num console.error perdido.
    try {
      await enviarEmailNovoPedido(order);
    } catch (err) {
      console.error(`Falha ao enviar e-mail de novo pedido (pedido #${order.id}):`, err);
      Sentry.captureException(err, { extra: { preferenceId, orderId: order.id, email: 'novo_pedido' } });
    }
    try {
      await enviarEmailConfirmacaoCliente(order);
    } catch (err) {
      console.error(`Falha ao enviar e-mail de confirmação pro cliente (pedido #${order.id}):`, err);
      Sentry.captureException(err, { extra: { preferenceId, orderId: order.id, email: 'confirmacao_cliente' } });
    }
  }
  return order;
}

// Notificação de pagamento aprovado da InfinitePay. O payload não é assinado
// (a criação do link também não usa token, só o handle público), então nunca
// confiamos nele sozinho — sempre confirmamos com uma chamada nossa pra
// /payment_check antes de aprovar o pedido, e conferimos se o valor pago bate
// com o total salvo (mesmo cuidado que já temos em /api/create-preference).
app.post('/webhook-infinitepay', webhookLimiter, async (req, res) => {
  const { order_nsu, transaction_nsu, invoice_slug } = req.body || {};
  try {
    if (order_nsu && pool) {
      const status = await consultarStatusPagamento({ orderNsu: order_nsu, transactionNsu: transaction_nsu, slug: invoice_slug });
      if (status.success && status.paid) {
        const { rows } = await pool.query('SELECT total FROM orders WHERE preference_id = $1', [order_nsu]);
        const pedido = rows[0];
        // Compara com "amount" (o valor que nós pedimos pra cobrar na criação
        // do link), não "paid_amount" (o que o cliente efetivamente pagou) —
        // em parcelamento com taxa repassada ao cliente, paid_amount vem MAIOR
        // que o total do pedido de propósito, e comparar com ele faria um
        // pagamento aprovado de verdade nunca bater e ficar pending pra sempre.
        if (pedido && Math.abs(Number(status.amount) / 100 - Number(pedido.total)) < 0.01) {
          await atualizarStatusPedido(order_nsu, 'approved', transaction_nsu);
        } else if (pedido) {
          console.error(`[webhook-infinitepay] Valor cobrado (R$ ${Number(status.amount) / 100}) não bate com o total do pedido ${order_nsu} (R$ ${pedido.total}) — não aprovado automaticamente.`);
        }
      }
    } else {
      console.log('Notificação recebida da InfinitePay sem order_nsu:', req.body);
    }
  } catch (err) {
    console.error('Erro ao processar notificação da InfinitePay:', err);
    return res.sendStatus(400); // resposta != 2xx faz a InfinitePay reenviar o webhook depois
  }
  res.sendStatus(200);
});

// Dados mínimos e públicos de um pedido (sem nome/e-mail/endereço do cliente),
// usados pela página de sucesso (registrar compra no Google Analytics) e pela
// página de rastreio (cliente consulta status/código com o número do pedido,
// que é o preference_id — o mesmo enviado no e-mail de confirmação).
app.get('/api/pedido/:preferenceId', asyncHandler(async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Banco de dados não configurado.' });
  const { rows } = await pool.query(
    'SELECT status, total, shipping_cost, items, tracking_code, created_at FROM orders WHERE preference_id = $1',
    [req.params.preferenceId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Pedido não encontrado.' });
  res.json(rows[0]);
}));

// Painéis administrativos, todos atrás de login (ver requireAdmin mais abaixo).
function reais(v) {
  return 'R$ ' + Number(v).toFixed(2).replace('.', ',');
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Express 4 não captura erro/rejeição de rota async automaticamente — sem
// isso, uma falha inesperada (ex.: soluço de conexão com o banco) vira uma
// promise rejeitada sem handler, que derruba o processo inteiro (loja E
// painel, ao mesmo tempo) até o Railway reiniciar sozinho. Todo handler
// async sem try/catch próprio passa por aqui.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Compara em tempo constante — "!==" direto vaza, por timing, quantos
// caracteres do início da senha o requisitante acertou (mais visível numa
// rota pública na internet do que pareceria à primeira vista).
function senhaCorreta(recebida) {
  if (!ADMIN_PASSWORD) return false;
  const hashRecebida = crypto.createHash('sha256').update(String(recebida ?? '')).digest();
  const hashEsperada = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(hashRecebida, hashEsperada);
}

// Login do painel: antes a senha ia em "?senha=..." em toda URL/link/form do
// admin — sobrava em log de acesso do Railway, no histórico do navegador e
// em qualquer link copiado. Agora é um login (POST) que gera um cookie de
// sessão assinado (HttpOnly, então nem JavaScript de uma eventual falha de
// XSS consegue ler; Secure, só viaja em HTTPS). Sem dependência nova: cookie
// é lido/escrito à mão, e a chave de assinatura deriva da própria senha do
// admin — não precisa de mais nenhuma variável de ambiente, e trocar a senha
// já invalida sozinho qualquer sessão antiga.
const crypto = require('crypto');
const SESSION_COOKIE = 'admin_sessao';
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000; // 12h

function getCookie(req, nome) {
  const header = req.headers.cookie;
  if (!header) return null;
  const par = header.split(';').map((s) => s.trim()).find((s) => s.startsWith(nome + '='));
  return par ? decodeURIComponent(par.slice(nome.length + 1)) : null;
}

function assinarSessao(exp) {
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  const assinatura = crypto.createHmac('sha256', ADMIN_PASSWORD || '').update(payload).digest('base64url');
  return `${payload}.${assinatura}`;
}

function sessaoValida(cookieValue) {
  if (!ADMIN_PASSWORD || !cookieValue) return false;
  const partes = String(cookieValue).split('.');
  if (partes.length !== 2) return false;
  const [payload, assinatura] = partes;
  const assinaturaEsperada = crypto.createHmac('sha256', ADMIN_PASSWORD).update(payload).digest('base64url');
  const bufRecebido = Buffer.from(assinatura);
  const bufEsperado = Buffer.from(assinaturaEsperada);
  if (bufRecebido.length !== bufEsperado.length) return false;
  if (!crypto.timingSafeEqual(bufRecebido, bufEsperado)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof exp === 'number' && Date.now() < exp;
  } catch {
    return false;
  }
}

// Só aceita caminho relativo interno (nunca um domínio externo) como destino
// pós-login, senão vira um open redirect (?proximo=https://phishing.com).
// Lista de permissão (não bloqueio de padrões específicos) — "//evil.com" e
// variações como "/\evil.com" (barra invertida, que navegadores às vezes
// tratam como barra normal ao montar a URL final do redirect) nunca batem
// com essa expressão regular, então nem precisam ser bloqueadas uma a uma.
function destinoSeguro(valor, fallback = '/admin') {
  if (typeof valor !== 'string' || !/^\/[a-zA-Z0-9\-_/]*(\?[a-zA-Z0-9\-_=&]*)?$/.test(valor)) return fallback;
  return valor;
}

function requireAdmin(req, res, next) {
  if (sessaoValida(getCookie(req, SESSION_COOKIE))) return next();
  res.redirect(`/admin/login?proximo=${encodeURIComponent(req.originalUrl)}`);
}

function loginPage({ erro, proximo } = {}) {
  return `
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Entrar - Café Só Grãos</title>
    <link rel="icon" href="/favicon.ico" sizes="any">
    <link href="https://api.fontshare.com/v2/css?f[]=tanker@400&f[]=general-sans@400,500,700&display=swap" rel="stylesheet">
    <meta name="theme-color" content="#211714">
    <style>
      * { box-sizing: border-box; }
      body {
        font-family: 'General Sans', -apple-system, BlinkMacSystemFont, sans-serif;
        margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
        background: #211714; color: #211714; padding: 16px;
      }
      .login-card { background: #fff; border-radius: 16px; padding: 32px 28px; width: 100%; max-width: 340px; }
      h1 { margin: 0 0 20px; font-size: 22px; font-family: 'Tanker', sans-serif; font-weight: 400; }
      input[type=password] {
        width: 100%; padding: 12px 14px; border: 1px solid #ddd; border-radius: 8px;
        font-size: 15px; font-family: inherit; margin-bottom: 12px;
      }
      button {
        width: 100%; padding: 12px; border-radius: 8px; border: none; background: #D66B3E;
        color: #fff; font-size: 14px; font-weight: 700; cursor: pointer; font-family: inherit;
      }
      .erro { color: #C53030; font-size: 13px; margin: -6px 0 12px; }
    </style>
    </head><body>
      <form class="login-card" method="POST" action="/admin/login">
        <h1>Painel — Café Só Grãos</h1>
        ${erro ? '<p class="erro">Senha incorreta.</p>' : ''}
        <input type="hidden" name="proximo" value="${escapeHtml(destinoSeguro(proximo))}">
        <input type="password" name="senha" placeholder="Senha" autofocus required>
        <button type="submit">Entrar</button>
      </form>
    </body></html>
  `;
}

app.get('/admin/login', (req, res) => {
  if (sessaoValida(getCookie(req, SESSION_COOKIE))) return res.redirect(destinoSeguro(req.query.proximo));
  res.send(loginPage({ proximo: req.query.proximo }));
});

app.post('/admin/login', express.urlencoded({ extended: false }), (req, res) => {
  const proximo = destinoSeguro(req.body?.proximo);
  if (!senhaCorreta(req.body?.senha)) {
    console.log(`[admin] login_falhou — IP ${req.ip}`);
    return res.status(401).send(loginPage({ erro: true, proximo }));
  }
  console.log(`[admin] login_ok — IP ${req.ip}`);
  const exp = Date.now() + SESSION_DURATION_MS;
  const cookie = [
    `${SESSION_COOKIE}=${encodeURIComponent(assinarSessao(exp))}`,
    'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/',
    `Max-Age=${Math.floor(SESSION_DURATION_MS / 1000)}`
  ].join('; ');
  res.setHeader('Set-Cookie', cookie);
  res.redirect(proximo);
});

app.get('/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  res.redirect('/admin/login');
});

// Painel restrito do vendedor (João): só gera link de pagamento avulso pra
// mandar pro cliente — login separado do admin, de propósito, pra ele nunca
// ter acesso a excluir pedido, ver outros painéis, etc. Mesmo esquema de
// sessão assinada do admin (cookie HttpOnly/Secure, chave derivada da própria
// senha), só que com senha e cookie próprios — as duas sessões nunca se misturam.
const VENDEDOR_PASSWORD = process.env.VENDEDOR_PASSWORD;
const VENDEDOR_SESSION_COOKIE = 'vendedor_sessao';

const vendedorLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Muitas tentativas. Tente novamente em alguns minutos.'
});
app.use('/vendedor', vendedorLimiter);

function senhaCorretaVendedor(recebida) {
  if (!VENDEDOR_PASSWORD) return false;
  const hashRecebida = crypto.createHash('sha256').update(String(recebida ?? '')).digest();
  const hashEsperada = crypto.createHash('sha256').update(VENDEDOR_PASSWORD).digest();
  return crypto.timingSafeEqual(hashRecebida, hashEsperada);
}

function assinarSessaoVendedor(exp) {
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  const assinatura = crypto.createHmac('sha256', VENDEDOR_PASSWORD || '').update(payload).digest('base64url');
  return `${payload}.${assinatura}`;
}

function sessaoValidaVendedor(cookieValue) {
  if (!VENDEDOR_PASSWORD || !cookieValue) return false;
  const partes = String(cookieValue).split('.');
  if (partes.length !== 2) return false;
  const [payload, assinatura] = partes;
  const assinaturaEsperada = crypto.createHmac('sha256', VENDEDOR_PASSWORD).update(payload).digest('base64url');
  const bufRecebido = Buffer.from(assinatura);
  const bufEsperado = Buffer.from(assinaturaEsperada);
  if (bufRecebido.length !== bufEsperado.length) return false;
  if (!crypto.timingSafeEqual(bufRecebido, bufEsperado)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof exp === 'number' && Date.now() < exp;
  } catch {
    return false;
  }
}

function requireVendedor(req, res, next) {
  if (sessaoValidaVendedor(getCookie(req, VENDEDOR_SESSION_COOKIE))) return next();
  res.redirect(`/vendedor/login?proximo=${encodeURIComponent(req.originalUrl)}`);
}

function vendedorLoginPage({ erro, proximo } = {}) {
  return `
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Entrar - Café Só Grãos</title>
    <link rel="icon" href="/favicon.ico" sizes="any">
    <link href="https://api.fontshare.com/v2/css?f[]=tanker@400&f[]=general-sans@400,500,700&display=swap" rel="stylesheet">
    <meta name="theme-color" content="#211714">
    <style>
      * { box-sizing: border-box; }
      body {
        font-family: 'General Sans', -apple-system, BlinkMacSystemFont, sans-serif;
        margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
        background: #211714; color: #211714; padding: 16px;
      }
      .login-card { background: #fff; border-radius: 16px; padding: 32px 28px; width: 100%; max-width: 340px; }
      h1 { margin: 0 0 20px; font-size: 22px; font-family: 'Tanker', sans-serif; font-weight: 400; }
      input[type=password] {
        width: 100%; padding: 12px 14px; border: 1px solid #ddd; border-radius: 8px;
        font-size: 15px; font-family: inherit; margin-bottom: 12px;
      }
      button {
        width: 100%; padding: 12px; border-radius: 8px; border: none; background: #D66B3E;
        color: #fff; font-size: 14px; font-weight: 700; cursor: pointer; font-family: inherit;
      }
      .erro { color: #C53030; font-size: 13px; margin: -6px 0 12px; }
    </style>
    </head><body>
      <form class="login-card" method="POST" action="/vendedor/login">
        <h1>Novo pedido — Café Só Grãos</h1>
        ${erro ? '<p class="erro">Senha incorreta.</p>' : ''}
        <input type="hidden" name="proximo" value="${escapeHtml(destinoSeguro(proximo, '/vendedor/novo-pedido'))}">
        <input type="password" name="senha" placeholder="Senha" autofocus required>
        <button type="submit">Entrar</button>
      </form>
    </body></html>
  `;
}

app.get('/vendedor/login', (req, res) => {
  if (sessaoValidaVendedor(getCookie(req, VENDEDOR_SESSION_COOKIE))) {
    return res.redirect(destinoSeguro(req.query.proximo, '/vendedor/novo-pedido'));
  }
  res.send(vendedorLoginPage({ proximo: req.query.proximo }));
});

app.post('/vendedor/login', express.urlencoded({ extended: false }), (req, res) => {
  const proximo = destinoSeguro(req.body?.proximo, '/vendedor/novo-pedido');
  if (!senhaCorretaVendedor(req.body?.senha)) {
    console.log(`[vendedor] login_falhou — IP ${req.ip}`);
    return res.status(401).send(vendedorLoginPage({ erro: true, proximo }));
  }
  console.log(`[vendedor] login_ok — IP ${req.ip}`);
  const exp = Date.now() + SESSION_DURATION_MS;
  const cookie = [
    `${VENDEDOR_SESSION_COOKIE}=${encodeURIComponent(assinarSessaoVendedor(exp))}`,
    'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/',
    `Max-Age=${Math.floor(SESSION_DURATION_MS / 1000)}`
  ].join('; ');
  res.setHeader('Set-Cookie', cookie);
  res.redirect(proximo);
});

app.get('/vendedor/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${VENDEDOR_SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  res.redirect('/vendedor/login');
});

function vendedorLayout(body) {
  return `
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Novo pedido - Café Só Grãos</title>
    <link rel="icon" href="/favicon.ico" sizes="any">
    <link href="https://api.fontshare.com/v2/css?f[]=tanker@400&f[]=general-sans@400,500,700&display=swap" rel="stylesheet">
    <meta name="theme-color" content="#211714">
    <style>
      * { box-sizing: border-box; }
      body {
        font-family: 'General Sans', -apple-system, BlinkMacSystemFont, sans-serif;
        margin: 0; background: #F7F5F4; color: #211714; -webkit-font-smoothing: antialiased;
      }
      .topo {
        position: sticky; top: 0; z-index: 10; background: #211714; color: #fff;
        padding: 14px 16px; display: flex; align-items: center; justify-content: space-between;
      }
      .topo a { color: rgba(255,255,255,.75); font-size: 13px; font-weight: 600; text-decoration: none; }
      .corpo { padding: 16px; max-width: 640px; margin: 0 auto; }
      h1 { margin: 4px 0 20px; font-size: 22px; font-family: 'Tanker', sans-serif; color: #211714; font-weight: 400; }
      section { background: #fff; border-radius: 14px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(33,23,20,.08); }
      section h2 { font-size: 12px; font-weight: 700; color: #8a6f5c; text-transform: uppercase; letter-spacing: .04em; margin: 0 0 12px; }
      .produto-linha { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0; border-bottom: 1px solid #F0E9E2; }
      .produto-linha:last-child { border-bottom: none; }
      .produto-linha label { font-size: 14px; font-weight: 600; }
      .produto-linha span { display: block; font-size: 12px; color: #8a6f5c; }
      .produto-linha input[type=number] { width: 64px; padding: 8px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; text-align: center; font-family: inherit; }
      .campo { margin-bottom: 10px; }
      .campo label { display: block; font-size: 12px; font-weight: 700; color: #5a4a3f; margin-bottom: 4px; }
      .campo input, .campo select { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; font-family: inherit; }
      .linha-dupla { display: flex; gap: 10px; }
      .linha-dupla .campo { flex: 1; }
      .btn { display: inline-block; width: 100%; padding: 14px; border-radius: 8px; border: none; background: #D66B3E; color: #fff; font-size: 15px; font-weight: 700; cursor: pointer; font-family: inherit; }
      .erro { background: #FBE2E2; color: #C53030; padding: 10px 14px; border-radius: 8px; font-size: 14px; margin-bottom: 14px; }
      .resultado-ok { background: #EAF4E9; color: #2E5C31; padding: 14px; border-radius: 10px; margin-bottom: 14px; }
      .link-gerado { width: 100%; padding: 12px; border: 1px solid #B8E0C4; border-radius: 8px; font-size: 13px; font-family: inherit; background: #fff; margin-top: 8px; }
      .resumo-linha { display: flex; justify-content: space-between; font-size: 14px; padding: 4px 0; }
      .resumo-linha.total { font-weight: 700; font-size: 16px; border-top: 1px solid #F0E9E2; margin-top: 6px; padding-top: 10px; }
    </style>
    </head><body>
    <div class="topo"><strong>Novo pedido</strong><a href="/vendedor/logout">Sair</a></div>
    <div class="corpo">${body}</div>
    </body></html>
  `;
}

function novoPedidoForm({ erro } = {}) {
  const produtosHtml = PRODUCTS.map((p) => `
    <div class="produto-linha">
      <div>
        <label for="qtd_${escapeHtml(p.id)}">${escapeHtml(p.nome)}</label>
        <span>${reais(p.preco)}</span>
      </div>
      <input type="number" id="qtd_${escapeHtml(p.id)}" name="qtd_${escapeHtml(p.id)}" min="0" max="50" value="0" inputmode="numeric">
    </div>
  `).join('');

  return vendedorLayout(`
    <h1>Montar pedido pro cliente</h1>
    ${erro ? `<p class="erro">${escapeHtml(erro)}</p>` : ''}
    <form method="POST" action="/vendedor/novo-pedido">
      <section>
        <h2>Produtos</h2>
        ${produtosHtml}
      </section>

      <section>
        <h2>Desconto (opcional)</h2>
        <div class="campo">
          <label for="desconto">Desconto sobre os produtos (%)</label>
          <input type="number" id="desconto" name="desconto" min="0" max="90" value="0" inputmode="numeric">
        </div>
      </section>

      <section>
        <h2>Cliente</h2>
        <div class="campo"><label for="nome">Nome completo</label><input type="text" id="nome" name="nome" required></div>
        <div class="campo"><label for="email">E-mail</label><input type="email" id="email" name="email" required></div>
        <div class="linha-dupla">
          <div class="campo"><label for="telefone">Telefone / WhatsApp</label><input type="tel" id="telefone" name="telefone"></div>
          <div class="campo"><label for="cpf">CPF</label><input type="text" id="cpf" name="cpf" inputmode="numeric" required></div>
        </div>
      </section>

      <section>
        <h2>Endereço de entrega</h2>
        <div class="campo"><label for="cep">CEP</label><input type="text" id="cep" name="cep" inputmode="numeric" required></div>
        <div class="campo"><label for="endereco">Rua</label><input type="text" id="endereco" name="endereco" required></div>
        <div class="linha-dupla">
          <div class="campo"><label for="numero">Número</label><input type="text" id="numero" name="numero" required></div>
          <div class="campo"><label for="complemento">Complemento</label><input type="text" id="complemento" name="complemento"></div>
        </div>
        <div class="campo"><label for="bairro">Bairro</label><input type="text" id="bairro" name="bairro" required></div>
        <div class="linha-dupla">
          <div class="campo"><label for="cidade">Cidade</label><input type="text" id="cidade" name="cidade" required></div>
          <div class="campo"><label for="estado">UF</label><input type="text" id="estado" name="estado" maxlength="2" required></div>
        </div>
      </section>

      <button type="submit" class="btn">Gerar link de pagamento</button>
    </form>
  `);
}

app.get('/vendedor/novo-pedido', requireVendedor, (req, res) => {
  res.send(novoPedidoForm());
});

app.post('/vendedor/novo-pedido', requireVendedor, express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  if (!pool) return res.status(500).send('Banco de dados não configurado.');

  // Preço e peso sempre vêm do catálogo do servidor — nunca do que o
  // formulário manda — mesma regra do checkout do site.
  const itensValidados = PRODUCTS
    .map((p) => ({ produto: p, quantity: Math.min(50, Math.max(0, parseInt(req.body?.[`qtd_${p.id}`]) || 0)) }))
    .filter(({ quantity }) => quantity > 0);

  if (itensValidados.length === 0) {
    return res.status(400).send(novoPedidoForm({ erro: 'Escolha pelo menos um produto.' }));
  }

  const descontoPercent = Math.min(90, Math.max(0, parseInt(req.body?.desconto) || 0));

  const cliente = {
    nome: String(req.body?.nome || '').trim().slice(0, 100),
    email: String(req.body?.email || '').trim().slice(0, 200),
    telefone: String(req.body?.telefone || '').trim().slice(0, 30),
    cpf: req.body?.cpf
  };
  const entrega = {
    cep: req.body?.cep,
    endereco: String(req.body?.endereco || '').trim().slice(0, 200),
    numero: String(req.body?.numero || '').trim().slice(0, 20),
    complemento: String(req.body?.complemento || '').trim().slice(0, 100),
    bairro: String(req.body?.bairro || '').trim().slice(0, 100),
    cidade: String(req.body?.cidade || '').trim().slice(0, 100),
    estado: String(req.body?.estado || '').trim().slice(0, 2).toUpperCase()
  };

  if (!cliente.nome || !entrega.cep || !entrega.endereco || !entrega.numero || !entrega.bairro || !entrega.cidade || !entrega.estado) {
    return res.status(400).send(novoPedidoForm({ erro: 'Preencha todos os dados obrigatórios do cliente e do endereço.' }));
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cliente.email)) {
    return res.status(400).send(novoPedidoForm({ erro: 'E-mail inválido.' }));
  }
  const cpfDigits = String(cliente.cpf || '').replace(/\D/g, '');
  if (!cpfValido(cpfDigits)) {
    return res.status(400).send(novoPedidoForm({ erro: 'CPF inválido.' }));
  }

  const itensParaPedido = itensValidados.map(({ produto, quantity }) => ({
    title: produto.nome,
    quantity,
    unit_price: descontoPercent > 0
      ? Number((produto.preco * (1 - descontoPercent / 100)).toFixed(2))
      : produto.preco
  }));

  const line_items = itensParaPedido.map((i) => ({ ...i, currency_id: 'BRL' }));

  const subtotalCatalogo = itensValidados.reduce((sum, { produto, quantity }) => sum + produto.preco * quantity, 0);
  const pesoTotalKg = itensValidados.reduce(
    (sum, { produto, quantity }) => sum + ((produto.pesoGramas || 300) * quantity) / 1000,
    0
  );

  let freteCalculado;
  try {
    freteCalculado = await calcularFrete(entrega.cep, pesoTotalKg);
  } catch (err) {
    console.error('Erro ao calcular frete (vendedor):', err.message);
    return res.status(400).send(novoPedidoForm({ erro: 'Não foi possível calcular o frete. Confira o CEP.' }));
  }
  const freteGratis = subtotalCatalogo >= FRETE_GRATIS_ACIMA_DE && cepEhSP(entrega.cep);
  const shippingCost = freteGratis ? 0 : freteCalculado.valor;
  const shippingCarrier = freteCalculado.transportadora || null;
  const shippingServiceId = freteCalculado.servicoId || null;
  if (shippingCost > 0) {
    line_items.push({ title: 'Frete', quantity: 1, unit_price: shippingCost, currency_id: 'BRL' });
  }

  const total = Number(line_items.reduce((sum, i) => sum + i.unit_price * i.quantity, 0).toFixed(2));

  const telefoneDigits = String(cliente.telefone || '').replace(/\D/g, '');
  const customer = { name: cliente.nome, email: cliente.email };
  if (telefoneDigits.length >= 10) customer.phone_number = '+55' + telefoneDigits;

  const orderNsu = crypto.randomUUID();
  const itensParaPagamento = line_items.filter((i) => i.unit_price > 0);

  let initPoint;
  try {
    initPoint = await criarLinkPagamento({
      items: itensParaPagamento,
      customer,
      address: {
        cep: String(entrega.cep || '').replace(/\D/g, ''),
        street: entrega.endereco,
        neighborhood: entrega.bairro,
        number: entrega.numero,
        complement: entrega.complemento || undefined
      },
      orderNsu,
      redirectUrl: `${SITE_URL}/sucesso.html`,
      webhookUrl: `${req.protocol}://${req.get('host')}/webhook-infinitepay`
    });
  } catch (err) {
    console.error('Erro ao criar link de pagamento (vendedor):', err);
    return res.status(500).send(novoPedidoForm({ erro: 'Erro ao gerar o link de pagamento. Tente de novo.' }));
  }

  await pool.query(
    `INSERT INTO orders
      (preference_id, status, customer_name, customer_email, customer_phone, customer_cpf, cep, address, address_number, address_complement, neighborhood, city, state, items, shipping_cost, shipping_carrier, shipping_service_id, shipping_weight_kg, total, free_gift, discount_id, discount_percent)
     VALUES ($1,'pending',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,false,NULL,$19)`,
    [
      orderNsu, cliente.nome, cliente.email, cliente.telefone || null, cpfDigits,
      entrega.cep, entrega.endereco, entrega.numero, entrega.complemento || null,
      entrega.bairro, entrega.cidade, entrega.estado, JSON.stringify(itensParaPedido),
      shippingCost, shippingCarrier, shippingServiceId, Number(pesoTotalKg.toFixed(3)), total,
      descontoPercent > 0 ? descontoPercent : null
    ]
  );
  logAdminAcao(req, 'pedido_manual_criado', `vendedor → pedido ${orderNsu} (${cliente.nome}, ${reais(total)})`);

  res.send(vendedorLayout(`
    <h1>Link gerado!</h1>
    <div class="resultado-ok">Copie o link abaixo e mande pro cliente. Ele só precisa clicar e pagar.</div>
    <section>
      <input type="text" class="link-gerado" value="${escapeHtml(initPoint)}" readonly onclick="this.select()">
    </section>
    <section>
      <h2>Resumo</h2>
      ${itensParaPedido.map((i) => `<div class="resumo-linha"><span>${i.quantity}x ${escapeHtml(i.title)}</span><span>${reais(i.unit_price * i.quantity)}</span></div>`).join('')}
      <div class="resumo-linha"><span>Frete${shippingCarrier ? ` (${escapeHtml(shippingCarrier)})` : ''}</span><span>${shippingCost === 0 ? 'Grátis' : reais(shippingCost)}</span></div>
      <div class="resumo-linha total"><span>Total</span><span>${reais(total)}</span></div>
    </section>
    <a href="/vendedor/novo-pedido" class="btn" style="text-align:center;text-decoration:none;display:block;">Montar outro pedido</a>
  `));
}));

// Layout compartilhado pelos painéis: mesma barra de navegação em todos,
// pra dar pra pular entre pedidos, avaliações, métricas, GA e InfinitePay
// sem digitar URL de novo.
function adminLayout({ title, ativo, body }) {
  const nav = [
    { id: 'painel', label: 'Painel', href: '/admin' },
    { id: 'pedidos', label: 'Pedidos', href: '/admin/pedidos' },
    { id: 'avaliacoes', label: 'Avaliações', href: '/admin/avaliacoes' },
    { id: 'leads', label: 'Contatos', href: '/admin/leads' },
    { id: 'ga', label: 'Google Analytics ↗', href: 'https://analytics.google.com/analytics/web/', external: true },
    { id: 'ip', label: 'InfinitePay ↗', href: 'https://app.infinitepay.io/', external: true },
    { id: 'me', label: 'Melhor Envio ↗', href: 'https://melhorenvio.com.br/painel', external: true },
    { id: 'sair', label: 'Sair', href: '/admin/logout' }
  ];
  const navHtml = nav.map((item) => `
    <a href="${item.href}" ${item.external ? 'target="_blank" rel="noopener noreferrer"' : ''} class="${item.id === ativo ? 'ativo' : ''}">${item.label}</a>
  `).join('');
  const refreshHtml = `<button class="admin-refresh" onclick="location.reload()" aria-label="Atualizar" title="Atualizar">⟳</button>`;

  return `
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)} - Café Só Grãos</title>
    <link rel="icon" href="/favicon.ico" sizes="any">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png">
    <link href="https://api.fontshare.com/v2/css?f[]=tanker@400&f[]=general-sans@400,500,700&display=swap" rel="stylesheet">
    <meta name="theme-color" content="#211714">
    <style>
      * { box-sizing: border-box; }
      body {
        font-family: 'General Sans', -apple-system, BlinkMacSystemFont, sans-serif;
        margin: 0; background: #F7F5F4; color: #211714; -webkit-font-smoothing: antialiased;
      }
      a { color: #D66B3E; text-decoration: none; }
      a:hover { text-decoration: underline; }

      .admin-nav {
        position: sticky; top: 0; z-index: 10; background: #211714;
        padding: 10px 12px; display: flex; align-items: center; gap: 8px;
      }
      .admin-nav-links {
        display: flex; gap: 4px; overflow-x: auto; -webkit-overflow-scrolling: touch; flex: 1; min-width: 0;
      }
      .admin-nav a {
        color: rgba(255,255,255,.65); font-size: 13px; font-weight: 600; text-decoration: none;
        padding: 8px 14px; border-radius: 999px; white-space: nowrap; transition: background .15s, color .15s;
      }
      .admin-nav a:hover { background: rgba(255,255,255,.08); color: #fff; }
      .admin-nav a.ativo { background: #D66B3E; color: #fff; }
      .admin-refresh {
        flex-shrink: 0; background: rgba(255,255,255,.1); border: none; color: #fff;
        width: 36px; height: 36px; border-radius: 999px; font-size: 18px; line-height: 1;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
      }
      .admin-refresh:hover { background: rgba(255,255,255,.2); }
      .admin-refresh:active { transform: rotate(180deg); transition: transform .3s; }

      .admin-body { padding: 16px; max-width: 900px; margin: 0 auto; }
      h1 { margin: 4px 0 20px; font-size: 24px; font-family: 'Tanker', sans-serif; color: #211714; font-weight: 400; }

      section { margin-bottom: 28px; }
      section h2 {
        font-size: 12px; font-weight: 700; color: #8a6f5c; text-transform: uppercase;
        letter-spacing: .04em; margin-bottom: 10px;
      }

      .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
      .card { background: #fff; border-radius: 12px; padding: 16px; box-shadow: 0 1px 3px rgba(33,23,20,.08); }
      .card span { display: block; font-size: 12px; color: #8a6f5c; margin-bottom: 4px; font-weight: 600; }
      .card strong { font-size: 22px; font-weight: 700; }
      .card.alerta { box-shadow: 0 1px 3px rgba(33,23,20,.08), inset 3px 0 0 #D66B3E; }
      .card.alerta strong { color: #D66B3E; }
      .card-link { display: inline-block; margin-top: 8px; font-size: 13px; font-weight: 700; }
      .aviso-frete { padding: 10px 14px; border-radius: 8px; font-size: 14px; margin-bottom: 14px; }
      .aviso-frete-ok { background: #EAF4E9; color: #2E5C31; }
      .aviso-frete-erro { background: #FBE2E2; color: #C53030; }

      table.mini { border-collapse: collapse; width: 100%; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(33,23,20,.08); }
      table.mini th, table.mini td { padding: 10px 14px; text-align: left; font-size: 13px; border-bottom: 1px solid #F0E9E2; }
      table.mini th { background: #FAF6F0; color: #5a4a3f; font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: .03em; }
      table.mini tr:last-child td { border-bottom: none; }

      .badge {
        display: inline-block; font-size: 11px; font-weight: 700; text-transform: uppercase;
        letter-spacing: .03em; padding: 4px 10px; border-radius: 999px;
      }
      .badge-pending { background: #FDF0DD; color: #B7791F; }
      .badge-approved { background: #DEF3E5; color: #1F8A4C; }
      .badge-rejected { background: #FBE2E2; color: #C53030; }
      .badge-in_process { background: #E4E9FB; color: #3651C7; }
      .badge-cancelled, .badge-refunded { background: #EDEAE6; color: #6B5B4F; }

      .filtros { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
      .filtros a {
        font-size: 12px; font-weight: 700; padding: 7px 14px; border-radius: 999px;
        background: #fff; color: #5a4a3f; box-shadow: 0 1px 3px rgba(33,23,20,.08);
      }
      .filtros a:hover { text-decoration: none; background: #F0E9E2; }
      .filtros a.ativo { background: #211714; color: #fff; }

      .lista-vazia { text-align: center; color: #8a6f5c; padding: 32px 16px; background: #fff; border-radius: 12px; font-size: 14px; }

      .pedido-lista, .avaliacao-lista { display: flex; flex-direction: column; gap: 12px; }
      .pedido-card, .avaliacao-card-admin { background: #fff; border-radius: 14px; padding: 16px; box-shadow: 0 1px 3px rgba(33,23,20,.08); }
      .pedido-topo { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 4px; }
      .pedido-cliente { font-weight: 700; font-size: 15px; margin-top: 6px; }
      .pedido-data { font-size: 12px; color: #8a6f5c; }
      .pedido-total { font-size: 18px; font-weight: 700; white-space: nowrap; }

      .pedido-selos { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
      .selo { font-size: 11px; background: #FDF0DD; color: #8a5a1f; padding: 4px 10px; border-radius: 999px; font-weight: 700; }

      .pedido-detalhe { font-size: 13px; color: #5a4a3f; line-height: 1.5; }
      .pedido-detalhe strong { color: #211714; }
      .pedido-itens { font-size: 13px; color: #5a4a3f; margin: 10px 0; padding: 10px 12px; background: #FAF6F0; border-radius: 8px; }
      .pedido-linhas { display: flex; justify-content: space-between; font-size: 13px; color: #5a4a3f; }

      .pedido-entrada {
        margin-top: 12px; padding: 10px 12px; border-radius: 8px;
        background: #FAF6F0; border: 1px solid #F0E9E2;
      }
      .pedido-entrada.marcada { background: #DEF3E5; border-color: #B8E0C4; }
      .pedido-entrada label {
        display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700;
        color: #5a4a3f; cursor: pointer;
      }
      .pedido-entrada.marcada label { color: #1F8A4C; }
      .pedido-entrada input[type=checkbox] { width: 18px; height: 18px; cursor: pointer; accent-color: #1F8A4C; }

      .pedido-acoes { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; padding-top: 14px; border-top: 1px solid #F0E9E2; }
      .pedido-acoes form { display: flex; gap: 6px; flex: 1; min-width: 220px; }
      .pedido-acoes input[type=text] { flex: 1; min-width: 0; }

      form { margin: 0; }
      .btn-mini {
        padding: 10px 16px; border-radius: 8px; border: none; font-size: 13px; font-weight: 700;
        cursor: pointer; white-space: nowrap; font-family: inherit;
      }
      .btn-mini-primary { background: #211714; color: #fff; }
      .btn-mini-danger { background: #fff; color: #C53030; border: 1px solid #F3C7C7; }
      input[type=text] {
        padding: 10px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 13px; font-family: inherit;
      }

      @media (max-width: 480px) {
        .admin-body { padding: 12px; }
        .cards { grid-template-columns: 1fr 1fr; }
        .pedido-acoes form { min-width: 100%; }
      }
    </style>
    </head><body>
    <nav class="admin-nav"><div class="admin-nav-links">${navHtml}</div>${refreshHtml}</nav>
    <div class="admin-body">${body}</div>
    </body></html>
  `;
}

// "pending" nunca significa "aprovado, falta despachar" (isso é "a_enviar")
// — significa que o cliente nem terminou de pagar. Chamar de "Pendente" dava
// a entender que era uma tarefa nossa (enviar o pacote); o rótulo "Não pago"
// deixa claro que o pedido não foi concluído do lado do cliente.
const STATUS_LABEL = { pending: 'Não pago', approved: 'Aprovado', rejected: 'Recusado', in_process: 'Em análise', cancelled: 'Cancelado', refunded: 'Reembolsado' };

// Textos fixos pro aviso de erro do fluxo de etiqueta — nunca texto vindo da
// URL direto (ver comentário em /admin/pedidos), então cada rota só manda um
// desses códigos, nunca a mensagem em si.
const FRETE_ERRO_MSG = {
  ja_no_carrinho: 'Esse pedido já tem um item no carrinho da Melhor Envio. Pra recomeçar, remova antes no painel da Melhor Envio.',
  sem_servico: 'Esse pedido não tem um serviço de frete cotado (provavelmente a cotação caiu na estimativa de reserva na hora da compra) — não dá pra saber qual transportadora usar.',
  sem_cpf: 'Esse pedido não tem CPF salvo (feito antes dessa funcionalidade existir) — não dá pra automatizar, precisa comprar a etiqueta direto no painel da Melhor Envio.',
  sem_telefone: 'Esse pedido não tem telefone do cliente salvo — a Melhor Envio pode recusar sem um contato do destinatário. Confirme o telefone com o cliente antes, ou compre a etiqueta direto no painel da Melhor Envio.',
  nao_no_carrinho: 'Esse pedido ainda não foi inserido no carrinho da Melhor Envio.',
  ja_tem_rastreio: 'Esse pedido já tem código de rastreio.',
  sem_codigo_rastreio: 'Pagamento e etiqueta gerados, mas não veio o código de rastreio na resposta — confira direto no painel da Melhor Envio e cole o código manualmente aqui.',
  sem_link_impressao: 'Não veio um link de impressão na resposta da Melhor Envio.',
  api_recusou: 'A Melhor Envio recusou essa operação. Confira o motivo exato nos logs do servidor.',
  erro_desconhecido: 'Algo deu errado nessa operação. Confira os logs do servidor pra detalhes.'
};

// Painel geral: vendas, pendências e produtos mais vendidos, com atalhos
// pros outros painéis e pro Google Analytics / InfinitePay.
app.get('/admin', requireAdmin, asyncHandler(async (req, res) => {
  if (!pool) return res.status(500).send('Banco de dados não configurado.');

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
          <a class="card-link" href="/admin/pedidos">Ver pedidos →</a>
        </div>
        <div class="card ${avaliacoesPendentes > 0 ? 'alerta' : ''}">
          <span>Avaliações aguardando aprovação</span><strong>${avaliacoesPendentes}</strong>
          <a class="card-link" href="/admin/avaliacoes">Ver avaliações →</a>
        </div>
      </div>
    </section>

    <section>
      <h2>Produtos mais vendidos</h2>
      <table class="mini">
        <tr><th>Produto</th><th>Unidades vendidas</th></tr>
        ${topProdutosRows.rows.map((p) => `<tr><td>${escapeHtml(p.titulo)}</td><td>${p.qtd}</td></tr>`).join('') || '<tr><td colspan="2">Ainda sem vendas aprovadas.</td></tr>'}
      </table>
    </section>

    <section>
      <h2>Pedidos por status</h2>
      <table class="mini">
        <tr><th>Status</th><th>Quantidade</th></tr>
        ${statusRows.rows.map((s) => `<tr><td><span class="badge badge-${escapeHtml(s.status)}">${escapeHtml(STATUS_LABEL[s.status] || s.status)}</span></td><td>${s.n}</td></tr>`).join('') || '<tr><td colspan="2">Nenhum pedido ainda.</td></tr>'}
      </table>
    </section>
  `;

  res.send(adminLayout({ title: 'Painel', ativo: 'painel', body }));
}));

// Trilha de auditoria das ações do admin (excluir pedido, editar rastreio,
// aprovar/rejeitar avaliação) — antes nada disso ficava registrado, então
// não dava pra saber depois quem mudou o quê.
function logAdminAcao(req, acao, detalhe) {
  console.log(`[admin] ${acao} — ${detalhe} — IP ${req.ip}`);
}

app.get('/admin/pedidos', requireAdmin, asyncHandler(async (req, res) => {
  if (!pool) return res.status(500).send('Banco de dados não configurado.');

  // "a_enviar"/"enviados" não são status de pagamento de verdade (esses
  // continuam intactos, batendo com o card "Pedidos por status" do painel
  // geral) — são um recorte à parte, só pra separar visualmente "aprovado
  // que falta despachar" de "aprovado que já saiu", que antes vinham tudo
  // junto sob "Aprovado" e misturava o que ainda precisava de ação.
  const filtro = ['pending', 'approved', 'rejected', 'in_process', 'cancelled', 'refunded', 'a_enviar', 'enviados'].includes(req.query.status)
    ? req.query.status
    : null;

  const CONDICOES = {
    a_enviar: `status = 'approved' AND (tracking_code IS NULL OR tracking_code = '')`,
    enviados: `status = 'approved' AND tracking_code IS NOT NULL AND tracking_code != ''`
  };

  const { rows } = await pool.query(
    filtro
      ? `SELECT * FROM orders WHERE ${CONDICOES[filtro] || 'status = $1'} ORDER BY created_at DESC LIMIT 200`
      : 'SELECT * FROM orders ORDER BY created_at DESC LIMIT 200',
    filtro && !CONDICOES[filtro] ? [filtro] : []
  );
  const filtroLink = (status) => `/admin/pedidos${status ? `?status=${status}` : ''}`;
  const FILTROS_EXTRA = { a_enviar: 'A enviar', enviados: 'Enviados' };
  const filtros = `
    <div class="filtros">
      <a href="${filtroLink(null)}" class="${!filtro ? 'ativo' : ''}">Todos</a>
      ${Object.keys(FILTROS_EXTRA).map((s) => `<a href="${filtroLink(s)}" class="${filtro === s ? 'ativo' : ''}">${escapeHtml(FILTROS_EXTRA[s])}</a>`).join('')}
      ${Object.keys(STATUS_LABEL).map((s) => `<a href="${filtroLink(s)}" class="${filtro === s ? 'ativo' : ''}">${escapeHtml(STATUS_LABEL[s])}</a>`).join('')}
    </div>
  `;

  const cartoes = rows.map((o) => `
    <div class="pedido-card">
      <div class="pedido-topo">
        <div>
          <span class="badge badge-${escapeHtml(o.status)}">${escapeHtml(STATUS_LABEL[o.status] || o.status)}</span>
          <div class="pedido-cliente">${escapeHtml(o.customer_name)}</div>
          <div class="pedido-data">${escapeHtml(new Date(o.created_at).toLocaleString('pt-BR'))}</div>
        </div>
        <div class="pedido-total">${reais(o.total)}</div>
      </div>
      ${(o.free_gift || o.discount_percent || o.tracking_code) ? `
        <div class="pedido-selos">
          ${o.free_gift ? '<span class="selo">🎁 Brinde</span>' : ''}
          ${o.discount_percent ? `<span class="selo">-${escapeHtml(o.discount_percent)}% cupom</span>` : ''}
          ${o.tracking_code ? `<span class="selo">📦 Enviado: ${escapeHtml(o.tracking_code)}</span>` : ''}
        </div>
      ` : ''}
      ${o.status === 'pending' && (Date.now() - new Date(o.created_at).getTime()) > 10 * 60 * 1000 ? `
        <div class="pedido-detalhe" style="margin-top:8px;color:#B7791F;">⚠️ Não pago há mais de 10 min — a InfinitePay não nos avisa se o pagamento falhar, então confira no <a href="https://app.infinitepay.io/" target="_blank" rel="noopener noreferrer">painel da InfinitePay</a> pela data/valor acima${o.customer_phone ? ` ou chame a pessoa no <a href="https://wa.me/55${escapeHtml(o.customer_phone.replace(/\D/g, ''))}" target="_blank" rel="noopener noreferrer">WhatsApp</a>` : ''}.</div>
      ` : ''}
      <div class="pedido-detalhe" style="margin-top:10px;"><strong>Contato:</strong> ${escapeHtml(o.customer_email)} · ${o.customer_phone ? `<a href="https://wa.me/55${escapeHtml(o.customer_phone.replace(/\D/g, ''))}" target="_blank" rel="noopener noreferrer">${escapeHtml(o.customer_phone)} ↗</a>` : 'sem telefone'}</div>
      <div class="pedido-detalhe"><strong>Endereço:</strong> ${escapeHtml(o.address)}, ${escapeHtml(o.address_number)} ${escapeHtml(o.address_complement || '')} — ${escapeHtml(o.neighborhood)}, ${escapeHtml(o.city)}/${escapeHtml(o.state)} · CEP ${escapeHtml(o.cep)}</div>
      <div class="pedido-itens">${(o.items || []).map((i) => `${escapeHtml(i.quantity)}x ${escapeHtml(i.title)}`).join('<br>')}</div>
      <div class="pedido-linhas"><span>Frete${o.shipping_carrier ? ` (${escapeHtml(o.shipping_carrier)})` : ''}</span><strong>${Number(o.shipping_cost) === 0 ? 'Grátis' : reais(o.shipping_cost)}</strong></div>
      <form method="POST" action="/admin/pedidos/${o.id}/entrada" class="pedido-entrada${o.entrada_sistema ? ' marcada' : ''}">
        <label>
          <input type="checkbox" ${o.entrada_sistema ? 'checked' : ''} onchange="this.form.submit()">
          Já dei entrada no sistema de vendas
        </label>
      </form>
      ${o.status === 'approved' && !o.tracking_code ? `
        <div class="pedido-acoes">
          ${!o.melhorenvio_order_id ? `
            <form method="POST" action="/admin/pedidos/${o.id}/frete/carrinho" onsubmit="this.querySelector('button').disabled=true;">
              <button type="submit" class="btn-mini btn-mini-primary">1. Inserir no carrinho (Melhor Envio)</button>
            </form>
          ` : `
            <span class="selo">📥 No carrinho da Melhor Envio (id ${escapeHtml(o.melhorenvio_order_id)})</span>
            <form method="POST" action="/admin/pedidos/${o.id}/frete/pagar" onsubmit="if (!confirm('Confirma que os dados batem? Isso vai debitar da carteira da Melhor Envio de verdade.')) return false; this.querySelector('button').disabled=true;">
              <button type="submit" class="btn-mini btn-mini-primary">2. Pagar e gerar etiqueta</button>
            </form>
          `}
        </div>
      ` : ''}
      ${o.melhorenvio_order_id && o.tracking_code ? `<div class="pedido-acoes"><a href="/admin/pedidos/${o.id}/frete/etiqueta" target="_blank" rel="noopener noreferrer" class="btn-mini btn-mini-primary" style="display:inline-block;text-decoration:none;text-align:center;">Baixar etiqueta (PDF)</a></div>` : ''}
      <div class="pedido-acoes">
        <form method="POST" action="/admin/pedidos/${o.id}/rastreio">
          <input type="text" name="codigo" placeholder="Código de rastreio" value="${escapeHtml(o.tracking_code || '')}">
          <button type="submit" class="btn-mini btn-mini-primary">${o.tracking_code ? 'Reenviar e-mail' : 'Marcar enviado'}</button>
        </form>
        <form method="POST" action="/admin/pedidos/${o.id}/excluir" onsubmit="return confirm('Excluir este pedido de ${escapeHtml(o.customer_name)}? Não tem como desfazer.');">
          <button type="submit" class="btn-mini btn-mini-danger">Excluir</button>
        </form>
      </div>
    </div>
  `).join('');

  // Mensagem do aviso de frete vem de um código fixo (nunca de texto livre na
  // URL) — antes qualquer um podia montar um link tipo
  // "/admin/pedidos?frete_ok=qualquer coisa" e fazer aparecer uma mensagem
  // forjada pro admin já logado. Com código fixo, o texto exibido só pode
  // ser um dos que a gente mesmo escreveu abaixo.
  let avisoFrete = '';
  if (req.query.frete_ok === 'carrinho') {
    avisoFrete = `<p class="aviso-frete aviso-frete-ok">Inserido no carrinho da Melhor Envio. Confira os dados e clique em "Pagar e gerar etiqueta" pra confirmar — ainda não foi cobrado nada.</p>`;
  } else if (req.query.frete_ok === 'pago') {
    const pedidoPago = rows.find((o) => String(o.id) === String(req.query.id));
    avisoFrete = `<p class="aviso-frete aviso-frete-ok">Etiqueta paga e gerada${pedidoPago?.tracking_code ? `! Código de rastreio ${escapeHtml(pedidoPago.tracking_code)}` : ''} — e-mail de envio disparado pro cliente.</p>`;
  } else if (FRETE_ERRO_MSG[req.query.frete_erro]) {
    avisoFrete = `<p class="aviso-frete aviso-frete-erro">${FRETE_ERRO_MSG[req.query.frete_erro]}</p>`;
  }

  const body = `
    <h1>Pedidos — Café Só Grãos</h1>
    ${avisoFrete}
    ${filtros}
    <div class="pedido-lista">
      ${cartoes || '<div class="lista-vazia">Nenhum pedido encontrado.</div>'}
    </div>
  `;
  res.send(adminLayout({ title: 'Pedidos', ativo: 'pedidos', body }));
}));

// Salva o código de rastreio de um pedido e avisa o cliente por e-mail.
app.post('/admin/pedidos/:id/rastreio', requireAdmin, express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  if (!pool) return res.status(500).send('Banco de dados não configurado.');

  const codigo = String(req.body?.codigo || '').trim().slice(0, 100);
  if (!codigo) return res.status(400).send('Informe um código de rastreio.');

  const { rows } = await pool.query(
    'UPDATE orders SET tracking_code = $1 WHERE id = $2 RETURNING *',
    [codigo, req.params.id]
  );
  const order = rows[0];
  if (order) await enviarEmailRastreio(order);
  logAdminAcao(req, 'rastreio_atualizado', `pedido #${req.params.id} → "${codigo}"`);

  res.redirect('/admin/pedidos');
}));

// Compra de etiqueta pela Melhor Envio, em 2 passos manuais de propósito:
// 1) insere no carrinho (não cobra nada, só reserva o serviço) — dá pra
//    conferir preço/endereço antes de gastar da carteira de verdade;
// 2) paga + gera a etiqueta + pega o código de rastreio, só depois de
//    confirmado que o passo 1 saiu certo.
function itensParaDeclaracao(order) {
  return (order.items || [])
    .filter((i) => i.title !== 'Frete')
    .map((i) => {
      let valor = Number(i.unit_price);
      // Brinde de boas-vindas sai com preço 0 pro cliente, mas a Melhor
      // Envio recusa "0.00" na declaração de conteúdo — precisa de um valor
      // de mercadoria maior que zero. Usa um valor simbólico.
      if (!valor) valor = 0.01;
      return {
        name: String(i.title).slice(0, 100),
        quantity: String(i.quantity),
        // toFixed(2) pra sempre virar algo tipo "6.00" ou "65.99" — a Melhor
        // Envio também recusa valores sem casas decimais (ex.: "47").
        unitary_value: valor.toFixed(2)
      };
    });
}

app.post('/admin/pedidos/:id/frete/carrinho', requireAdmin, asyncHandler(async (req, res) => {
  if (!pool) return res.status(500).send('Banco de dados não configurado.');
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  const order = rows[0];
  if (!order) return res.redirect('/admin/pedidos');

  try {
    if (order.melhorenvio_order_id) {
      throw new Error('ja_no_carrinho');
    }
    if (!order.shipping_service_id) {
      throw new Error('sem_servico');
    }
    if (!order.customer_cpf) {
      throw new Error('sem_cpf');
    }
    // Telefone é opcional no checkout, mas a Melhor Envio pode recusar a
    // inserção no carrinho sem um contato do destinatário — melhor avisar
    // isso claramente aqui do que deixar a API devolver um erro genérico.
    if (!order.customer_phone) {
      throw new Error('sem_telefone');
    }

    const resultado = await inserirNoCarrinho({
      orderId: order.id,
      orderNsu: order.preference_id,
      servicoId: order.shipping_service_id,
      pesoKg: Number(order.shipping_weight_kg) || 0.3,
      valorSeguro: Math.max(0, Number(order.total) - Number(order.shipping_cost)),
      destinatario: {
        name: order.customer_name,
        phone: String(order.customer_phone || '').replace(/\D/g, ''),
        email: order.customer_email,
        document: order.customer_cpf,
        address: order.address,
        number: order.address_number,
        complement: order.address_complement,
        district: order.neighborhood,
        city: order.city,
        state_abbr: order.state,
        postal_code: String(order.cep || '').replace(/\D/g, '')
      },
      produtos: itensParaDeclaracao(order)
    });

    await pool.query('UPDATE orders SET melhorenvio_order_id = $1 WHERE id = $2', [resultado.id, order.id]);
    logAdminAcao(req, 'frete_carrinho', `pedido #${order.id} → item Melhor Envio ${resultado.id}`);
    res.redirect('/admin/pedidos?frete_ok=carrinho');
  } catch (err) {
    console.error(`Erro ao inserir pedido #${order.id} no carrinho da Melhor Envio:`, err.message);
    const codigo = FRETE_ERRO_MSG[err.message] ? err.message : 'api_recusou';
    res.redirect(`/admin/pedidos?frete_erro=${codigo}`);
  }
}));

app.post('/admin/pedidos/:id/frete/pagar', requireAdmin, asyncHandler(async (req, res) => {
  if (!pool) return res.status(500).send('Banco de dados não configurado.');
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  const order = rows[0];
  if (!order) return res.redirect('/admin/pedidos');

  try {
    if (!order.melhorenvio_order_id) {
      throw new Error('nao_no_carrinho');
    }
    if (order.tracking_code) {
      throw new Error('ja_tem_rastreio');
    }

    await comprarEtiquetas([order.melhorenvio_order_id]);
    await gerarEtiquetas([order.melhorenvio_order_id]);

    // A transportadora não devolve o código de rastreio na hora — leva alguns
    // segundos entre a etiqueta ser gerada e a Melhor Envio receber o código
    // de volta. Sem essa espera, a consulta abaixo quase sempre vem vazia.
    let codigo = null;
    for (let tentativa = 0; tentativa < 5 && !codigo; tentativa++) {
      if (tentativa > 0) await new Promise((resolve) => setTimeout(resolve, 4000));
      const rastreio = await rastrearEtiquetas([order.melhorenvio_order_id]);
      codigo = rastreio?.[order.melhorenvio_order_id]?.tracking
        || (Array.isArray(rastreio) ? rastreio.find((r) => String(r.id) === String(order.melhorenvio_order_id))?.tracking : null);
    }
    if (!codigo) {
      throw new Error('sem_codigo_rastreio');
    }

    const { rows: atualizado } = await pool.query('UPDATE orders SET tracking_code = $1 WHERE id = $2 RETURNING *', [codigo, order.id]);
    await enviarEmailRastreio(atualizado[0]);
    logAdminAcao(req, 'frete_pago', `pedido #${order.id} → rastreio ${codigo}`);
    res.redirect(`/admin/pedidos?frete_ok=pago&id=${order.id}`);
  } catch (err) {
    console.error(`Erro ao pagar/gerar etiqueta do pedido #${order.id}:`, err.message);
    const codigo = FRETE_ERRO_MSG[err.message] ? err.message : 'api_recusou';
    res.redirect(`/admin/pedidos?frete_erro=${codigo}`);
  }
}));

app.get('/admin/pedidos/:id/frete/etiqueta', requireAdmin, asyncHandler(async (req, res) => {
  if (!pool) return res.status(500).send('Banco de dados não configurado.');
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  const order = rows[0];
  if (!order?.melhorenvio_order_id) return res.redirect('/admin/pedidos');

  try {
    const resultado = await imprimirEtiquetas([order.melhorenvio_order_id]);
    if (!resultado.url) throw new Error('sem_link_impressao');
    res.redirect(resultado.url);
  } catch (err) {
    console.error(`Erro ao imprimir etiqueta do pedido #${order.id}:`, err.message);
    const codigo = FRETE_ERRO_MSG[err.message] ? err.message : 'api_recusou';
    res.redirect(`/admin/pedidos?frete_erro=${codigo}`);
  }
}));

// Alterna a marcação "já dei entrada no sistema de vendas" — controle manual
// do admin, sem relação com o status de pagamento/rastreio do pedido.
app.post('/admin/pedidos/:id/entrada', requireAdmin, asyncHandler(async (req, res) => {
  if (!pool) return res.status(500).send('Banco de dados não configurado.');

  await pool.query('UPDATE orders SET entrada_sistema = NOT COALESCE(entrada_sistema, false) WHERE id = $1', [req.params.id]);
  logAdminAcao(req, 'entrada_alternada', `pedido #${req.params.id}`);

  res.redirect('/admin/pedidos');
}));

// Exclui um pedido (ex.: pedidos de teste feitos durante o desenvolvimento).
app.post('/admin/pedidos/:id/excluir', requireAdmin, asyncHandler(async (req, res) => {
  if (!pool) return res.status(500).send('Banco de dados não configurado.');

  await pool.query('DELETE FROM orders WHERE id = $1', [req.params.id]);
  logAdminAcao(req, 'pedido_excluido', `pedido #${req.params.id}`);

  res.redirect('/admin/pedidos');
}));

// Avaliações de clientes (estilo Google: nome, nota de 1-5, comentário).
// Toda avaliação nova entra como "pending" e só aparece no site depois de
// aprovada manualmente — evita comentário falso de concorrente ou spam.
const LINHAS_PRODUTO = ['Tradicional', 'Gourmet', 'Especial', 'Drip Coffee'];

app.post('/api/avaliacoes', formularioLimiter, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'Banco de dados não configurado.' });
    const nome = String(req.body?.nome || '').trim().slice(0, 100);
    const nota = Math.round(Number(req.body?.nota));
    const comentario = String(req.body?.comentario || '').trim().slice(0, 600);
    const produto = String(req.body?.produto || '').trim();

    if (!nome || !comentario || !(nota >= 1 && nota <= 5) || !LINHAS_PRODUTO.includes(produto)) {
      return res.status(400).json({ error: 'Preencha nome, nota (1 a 5), qual produto comprou e o comentário.' });
    }

    await pool.query(
      'INSERT INTO reviews (customer_name, rating, comment, product_line) VALUES ($1, $2, $3, $4)',
      [nome, nota, comentario, produto]
    );
    res.json({ ok: true, message: 'Recebemos sua avaliação! Ela vai aparecer no site assim que for revisada.' });
  } catch (err) {
    console.error('Erro ao salvar avaliação:', err);
    res.status(500).json({ error: 'Não foi possível enviar sua avaliação.' });
  }
});

// Avaliações já aprovadas, públicas — usadas na seção "O que dizem sobre a gente".
app.get('/api/avaliacoes', asyncHandler(async (req, res) => {
  if (!pool) return res.json([]);
  const { rows } = await pool.query(
    `SELECT customer_name, rating, comment, product_line, created_at FROM reviews
     WHERE status = 'approved' ORDER BY created_at DESC LIMIT 30`
  );
  res.json(rows);
}));

// Painel de moderação das avaliações, protegido por senha.
const REVIEW_STATUS_LABEL = { pending: 'Pendente', approved: 'Aprovada', rejected: 'Rejeitada' };

app.get('/admin/avaliacoes', requireAdmin, asyncHandler(async (req, res) => {
  if (!pool) return res.status(500).send('Banco de dados não configurado.');

  const filtro = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;

  const { rows } = await pool.query(
    filtro
      ? 'SELECT * FROM reviews WHERE status = $1 ORDER BY created_at DESC LIMIT 300'
      : 'SELECT * FROM reviews ORDER BY created_at DESC LIMIT 300',
    filtro ? [filtro] : []
  );
  const estrelas = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);

  const filtroLink = (status) => `/admin/avaliacoes${status ? `?status=${status}` : ''}`;
  const filtros = `
    <div class="filtros">
      <a href="${filtroLink(null)}" class="${!filtro ? 'ativo' : ''}">Todas</a>
      ${Object.keys(REVIEW_STATUS_LABEL).map((s) => `<a href="${filtroLink(s)}" class="${filtro === s ? 'ativo' : ''}">${escapeHtml(REVIEW_STATUS_LABEL[s])}</a>`).join('')}
    </div>
  `;

  const cartoes = rows.map((r) => `
    <div class="avaliacao-card-admin">
      <div class="pedido-topo">
        <div>
          <span class="badge badge-${escapeHtml(r.status)}">${escapeHtml(REVIEW_STATUS_LABEL[r.status] || r.status)}</span>
          <div class="pedido-cliente">${escapeHtml(r.customer_name)}</div>
          <div class="pedido-data">${escapeHtml(new Date(r.created_at).toLocaleString('pt-BR'))}${r.product_line ? ` · Comprou: ${escapeHtml(r.product_line)}` : ''}</div>
        </div>
        <div class="pedido-total" style="color:#D66B3E;">${estrelas(r.rating)}</div>
      </div>
      <div class="pedido-itens">"${escapeHtml(r.comment)}"</div>
      <div class="pedido-acoes">
        ${r.status !== 'approved' ? `<form method="POST" action="/admin/avaliacoes/${r.id}/aprovar"><button type="submit" class="btn-mini btn-mini-primary">Aprovar</button></form>` : ''}
        ${r.status !== 'rejected' ? `<form method="POST" action="/admin/avaliacoes/${r.id}/rejeitar"><button type="submit" class="btn-mini btn-mini-danger">Rejeitar</button></form>` : ''}
      </div>
    </div>
  `).join('');

  const body = `
    <h1>Avaliações — Café Só Grãos</h1>
    ${filtros}
    <div class="avaliacao-lista">
      ${cartoes || '<div class="lista-vazia">Nenhuma avaliação encontrada.</div>'}
    </div>
  `;
  res.send(adminLayout({ title: 'Avaliações', ativo: 'avaliacoes', body }));
}));

app.post('/admin/avaliacoes/:id/:acao', requireAdmin, asyncHandler(async (req, res) => {
  if (!pool) return res.status(500).send('Banco de dados não configurado.');
  const acao = req.params.acao;
  if (!['aprovar', 'rejeitar'].includes(acao)) return res.status(400).send('Ação inválida.');
  const status = acao === 'aprovar' ? 'approved' : 'rejected';
  await pool.query('UPDATE reviews SET status = $1 WHERE id = $2', [status, req.params.id]);
  logAdminAcao(req, 'avaliacao_' + acao, `avaliação #${req.params.id}`);
  res.redirect('/admin/avaliacoes');
}));

// Formulário "avise-me" do site: captura contato de quem visitou mas ainda
// não comprou, pra dar pra reengajar depois (novidade de torra, promoção).
// E-mail é a chave única — reenviar o formulário com o mesmo e-mail não
// duplica linha nem manda o e-mail de boas-vindas de novo.
app.post('/api/newsletter', formularioLimiter, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'Banco de dados não configurado.' });
    const nome = String(req.body?.nome || '').trim().slice(0, 100);
    const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 200);
    const telefone = String(req.body?.telefone || '').trim().slice(0, 30);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Informe um e-mail válido.' });
    }

    const { rows } = await pool.query(
      'INSERT INTO leads (name, email, phone) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING RETURNING id',
      [nome || null, email, telefone || null]
    );
    // O contato já está salvo nesse ponto — se o envio do e-mail falhar (rede
    // instável, Resend fora do ar), isso não pode virar erro pro visitante,
    // que já teve o dado guardado com sucesso. Só loga pra investigar depois.
    if (rows.length > 0) {
      try {
        await enviarEmailBoasVindasLead({ name: nome, email });
      } catch (emailErr) {
        console.error('Contato salvo, mas falhou o e-mail de boas-vindas:', emailErr);
      }
    }
    res.json({ ok: true, message: 'Prontinho! Você vai ficar sabendo das novidades em primeira mão.' });
  } catch (err) {
    console.error('Erro ao salvar contato:', err);
    res.status(500).json({ error: 'Não foi possível salvar seu contato agora.' });
  }
});

// Popup de cadastro na entrada do site (nome + telefone, sem e-mail) — quem
// se cadastra aqui e faz a primeira compra ganha 2 Drip Coffee de brinde em
// vez de 1 (conferido por telefone em /api/create-preference). Diferente do
// formulário "avise-me" do rodapé, que não dá direito a esse bônus.
app.post('/api/cadastro-popup', formularioLimiter, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'Banco de dados não configurado.' });
    const nome = String(req.body?.nome || '').trim().slice(0, 100);
    const telefone = String(req.body?.telefone || '').trim().slice(0, 30);
    const telefoneDigits = telefone.replace(/\D/g, '');

    if (!nome || telefoneDigits.length < 10) {
      return res.status(400).json({ error: 'Informe seu nome e um telefone válido com DDD.' });
    }

    await pool.query(
      'INSERT INTO leads (name, phone, cadastro_popup) VALUES ($1, $2, true)',
      [nome, telefone]
    );
    res.json({ ok: true, message: 'Cadastro feito! Na sua primeira compra, você ganha 2 Drip Coffee de brinde.' });
  } catch (err) {
    console.error('Erro ao salvar cadastro do popup:', err);
    res.status(500).json({ error: 'Não foi possível salvar seu cadastro agora.' });
  }
});

// Lista de contatos captados, protegida por senha — pra você mesmo chamar
// no WhatsApp manualmente (não existe envio em massa automático por WhatsApp).
app.get('/admin/leads', requireAdmin, asyncHandler(async (req, res) => {
  if (!pool) return res.status(500).send('Banco de dados não configurado.');

  const { rows } = await pool.query('SELECT * FROM leads ORDER BY created_at DESC LIMIT 500');

  const cartoes = rows.map((l) => `
    <div class="pedido-card">
      <div class="pedido-topo">
        <div>
          <div class="pedido-cliente">${escapeHtml(l.name || 'Sem nome')}</div>
          <div class="pedido-data">${escapeHtml(new Date(l.created_at).toLocaleString('pt-BR'))}</div>
        </div>
      </div>
      ${l.cadastro_popup ? `<div class="pedido-selos"><span class="selo">🎁 Popup — ganha 2 Drip Coffee na 1ª compra</span></div>` : ''}
      ${l.email ? `<div class="pedido-detalhe" style="margin-top:10px;"><strong>E-mail:</strong> ${escapeHtml(l.email)}</div>` : ''}
      ${l.phone ? `<div class="pedido-detalhe"><strong>WhatsApp:</strong> ${escapeHtml(l.phone)}</div>` : ''}
    </div>
  `).join('');

  const body = `
    <h1>Contatos — Café Só Grãos</h1>
    <p class="pedido-detalhe" style="margin-bottom:14px;">${rows.length} contato${rows.length === 1 ? '' : 's'} captado${rows.length === 1 ? '' : 's'} pelo formulário do site. Envio de novidades por e-mail e WhatsApp continua manual, feito por você.</p>
    <div class="pedido-lista">
      ${cartoes || '<div class="lista-vazia">Nenhum contato captado ainda.</div>'}
    </div>
  `;
  res.send(adminLayout({ title: 'Contatos', ativo: 'leads', body }));
}));

app.get('/health', (req, res) => res.json({ ok: true }));

// Manda pro Sentry antes da rede de segurança final abaixo — precisa vir
// depois de todas as rotas e antes de qualquer outro error handler.
Sentry.setupExpressErrorHandler(app);

// Rede de segurança final: qualquer erro que escapou de uma rota (via
// asyncHandler ou next(err) direto) cai aqui em vez de derrubar o processo.
app.use((err, req, res, next) => {
  console.error('Erro não tratado numa rota:', err);
  if (res.headersSent) return next(err);
  if (req.path.startsWith('/api/') || req.path.startsWith('/webhook')) {
    res.status(500).json({ error: 'Erro interno no servidor.' });
  } else {
    res.status(500).send('Ocorreu um erro inesperado. Tente novamente em instantes.');
  }
});

const PORT = process.env.PORT || 3000;
initDb().finally(() => {
  app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
  if (pool) agendarBackupDiario(pool);
});
