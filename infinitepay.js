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
  const data = await res.json();
  // Sem isso, uma falha de verdade da API (chave inválida, API fora do ar,
  // 500) voltava um corpo sem "success"/"paid", e os dois chamadores (o
  // webhook e a reconciliação automática) só checam esses dois campos —
  // tratavam silenciosamente como "ainda não pago" em vez de um erro real,
  // sem nenhum alerta. Os dois já têm try/catch com Sentry em volta da
  // chamada, então lançar aqui já basta pra isso aparecer de verdade.
  if (!res.ok) throw new Error(`InfinitePay retornou erro ao consultar pagamento (${res.status}): ${JSON.stringify(data)}`);
  // NÃO dá pra também exigir que "data.success" seja booleano aqui: a
  // reconciliação automática chama isso sem transaction_nsu/slug pra pedidos
  // "pending" que podem nunca ter sido pagos de verdade, e nesse caso um
  // corpo sem "success"/"paid" é uma resposta válida de "nada encontrado
  // ainda", não um erro — tratar isso como erro geraria alerta repetido pra
  // todo pedido abandonado (o que esse código já evita no outro ponto).
  return data;
}

module.exports = { criarLinkPagamento, consultarStatusPagamento };
