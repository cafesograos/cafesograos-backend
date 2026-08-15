const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'alberto.adm@cafesograos.com.br';
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'Café Só Grãos <onboarding@resend.dev>';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function enviarEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    console.warn('AVISO: RESEND_API_KEY não definido. E-mail não enviado:', subject);
    return { ok: false, motivo: 'RESEND_API_KEY não definido' };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html })
  });

  if (!res.ok) {
    const body = await res.text();
    console.error('Erro ao enviar e-mail via Resend:', res.status, body);
    return { ok: false, status: res.status, body };
  }
  console.log('E-mail enviado para', to, '—', subject);
  return { ok: true };
}

function itensHtml(order) {
  return (order.items || [])
    .map((i) => `<li>${escapeHtml(i.quantity)}x ${escapeHtml(i.title)} — R$ ${Number(i.unit_price).toFixed(2)}</li>`)
    .join('');
}

async function enviarEmailNovoPedido(order) {
  const html = `
    <h2>Novo pedido pago — Café Só Grãos</h2>
    ${order.free_gift ? '<p>🎁 <strong>Primeira compra desse cliente — não esquecer de incluir o Drip Coffee de brinde na caixa.</strong></p>' : ''}
    ${order.discount_percent ? `<p>Pedido com ${Number(order.discount_percent)}% de desconto de cliente recorrente aplicado.</p>` : ''}
    <p><strong>Cliente:</strong> ${escapeHtml(order.customer_name)} (${escapeHtml(order.customer_email)}, ${escapeHtml(order.customer_phone || 'sem telefone')})</p>
    <p><strong>Endereço de entrega:</strong><br>
      ${escapeHtml(order.address)}, ${escapeHtml(order.address_number)} ${escapeHtml(order.address_complement || '')}<br>
      ${escapeHtml(order.neighborhood)} — ${escapeHtml(order.city)}/${escapeHtml(order.state)}<br>
      CEP: ${escapeHtml(order.cep)}
    </p>
    <p><strong>Itens:</strong></p>
    <ul>${itensHtml(order)}</ul>
    <p><strong>Frete:</strong> ${Number(order.shipping_cost) === 0 ? 'Grátis' : 'R$ ' + Number(order.shipping_cost).toFixed(2)}</p>
    <p><strong>Total:</strong> R$ ${Number(order.total).toFixed(2)}</p>
    <p><strong>ID da preferência:</strong> ${escapeHtml(order.preference_id)}</p>
  `;

  return enviarEmail({
    to: NOTIFY_EMAIL,
    subject: `Novo pedido — ${order.customer_name} — R$ ${Number(order.total).toFixed(2)}`,
    html
  });
}

// Confirmação enviada ao próprio cliente assim que o pagamento é aprovado.
async function enviarEmailConfirmacaoCliente(order) {
  if (!order.customer_email) return { ok: false, motivo: 'pedido sem e-mail do cliente' };

  const brindeHtml = order.free_gift
    ? `<p>🎁 <strong>De boas-vindas</strong>, incluímos um Drip Coffee grátis no seu pedido! E você já ganhou um cupom de <strong>5% de desconto</strong> para a próxima compra, válido por 30 dias — é automático, basta usar este mesmo e-mail no checkout.</p>`
    : '';
  const descontoHtml = order.discount_percent
    ? `<p>🎉 Aplicamos ${Number(order.discount_percent)}% de desconto neste pedido — nosso presente por você ter voltado.</p>`
    : '';

  const html = `
    <h2>Recebemos seu pedido! ☕</h2>
    <p>Oi, ${escapeHtml(order.customer_name)}! Seu pagamento foi aprovado e já vamos preparar seu café.</p>
    ${brindeHtml}
    ${descontoHtml}
    <p><strong>Número do pedido:</strong> ${escapeHtml(order.preference_id)}<br>
      <span style="color:#8a6f5c;font-size:13px;">Guarde esse número — é com ele que você consulta o status em <a href="https://www.cafesograos.com.br/rastreio.html">cafesograos.com.br/rastreio.html</a></span>
    </p>
    <p><strong>Itens do pedido:</strong></p>
    <ul>${itensHtml(order)}</ul>
    <p><strong>Frete:</strong> ${Number(order.shipping_cost) === 0 ? 'Grátis' : 'R$ ' + Number(order.shipping_cost).toFixed(2)}</p>
    <p><strong>Total:</strong> R$ ${Number(order.total).toFixed(2)}</p>
    <p><strong>Endereço de entrega:</strong><br>
      ${escapeHtml(order.address)}, ${escapeHtml(order.address_number)} ${escapeHtml(order.address_complement || '')}<br>
      ${escapeHtml(order.neighborhood)} — ${escapeHtml(order.city)}/${escapeHtml(order.state)}<br>
      CEP: ${escapeHtml(order.cep)}
    </p>
    <p>Assim que seu pedido for enviado, mandamos outro e-mail com o código de rastreio.</p>
    <p>Qualquer dúvida, é só responder este e-mail ou chamar no WhatsApp (16) 99756-7559.</p>
    <p>Obrigado por comprar conosco!<br>Café Só Grãos</p>
  `;

  return enviarEmail({
    to: order.customer_email,
    subject: 'Recebemos seu pedido — Café Só Grãos',
    html
  });
}

// Aviso de envio com código de rastreio, disparado manualmente pelo admin
// (painel /admin/pedidos) quando o pacote sai para entrega.
async function enviarEmailRastreio(order) {
  if (!order.customer_email || !order.tracking_code) return { ok: false, motivo: 'faltam e-mail ou código de rastreio' };

  const html = `
    <h2>Seu pedido foi enviado! 📦</h2>
    <p>Oi, ${escapeHtml(order.customer_name)}! Seu café já está a caminho.</p>
    <p><strong>Código de rastreio:</strong> ${escapeHtml(order.tracking_code)}</p>
    <p>Você pode acompanhar a entrega no site dos Correios ou da transportadora usando esse código.</p>
    <p>Qualquer dúvida, é só responder este e-mail ou chamar no WhatsApp (16) 99756-7559.</p>
    <p>Obrigado por comprar conosco!<br>Café Só Grãos</p>
  `;

  return enviarEmail({
    to: order.customer_email,
    subject: 'Seu pedido foi enviado — Café Só Grãos',
    html
  });
}

module.exports = { enviarEmailNovoPedido, enviarEmailConfirmacaoCliente, enviarEmailRastreio };
