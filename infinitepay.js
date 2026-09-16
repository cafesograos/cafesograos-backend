const IP_BASE = 'https://api.checkout.infinitepay.io';
const HANDLE = process.env.INFINITEPAY_HANDLE;

// A InfinitePay não usa token/chave de API na criação do link — só o handle
// (que é público, aparece na URL do checkout). Por isso o webhook nunca pode
// ser tratado como fonte de verdade sozinho: sempre confirmamos com uma
// chamada nossa a /payment_check antes de considerar um pedido pago de verdade.

function centavos(valorReais) {
  return Math.round(Number(valorReais) * 100);
}

// Cria o link de pagamento pro pedido. "items" já vem filtrado (só itens com
// valor > 0 — a API rejeita item com price 0, então o brinde de boas-vindas
// não entra aqui, mas continua registrado normalmente no pedido/e-mail).
async function criarLinkPagamento({ items, customer, address, orderNsu, redirectUrl, webhookUrl }) {
  if (!HANDLE) throw new Error('INFINITEPAY_HANDLE não está configurado.');

  const body = {
    handle: HANDLE,
    order_nsu: orderNsu,
    items: items.map((i) => ({
      quantity: i.quantity,
      price: centavos(i.unit_price),
      description: i.title
    }))
  };
  if (redirectUrl) body.redirect_url = redirectUrl;
  if (webhookUrl) body.webhook_url = webhookUrl;
  if (customer) body.customer = customer;
  if (address) body.address = address;

  const res = await fetch(`${IP_BASE}/links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok || !data.url) {
    throw new Error('InfinitePay recusou a criação do link: ' + JSON.stringify(data));
  }
  return data.url;
}

// Confirma de verdade o status de um pagamento — usado tanto pelo webhook
// (que não é assinado, então não pode ser confiado sozinho) quanto por
// qualquer conferência manual futura. Exige transaction_nsu e slug, que só
// existem depois que o cliente termina o pagamento (não dá pra usar isso
// pra descobrir pedidos abandonados antes de pagar).
async function consultarStatusPagamento({ orderNsu, transactionNsu, slug }) {
  if (!HANDLE) throw new Error('INFINITEPAY_HANDLE não está configurado.');

  const res = await fetch(`${IP_BASE}/payment_check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      handle: HANDLE,
      order_nsu: orderNsu,
      transaction_nsu: transactionNsu,
      slug
    })
  });
  return res.json();
}

module.exports = { criarLinkPagamento, consultarStatusPagamento };
