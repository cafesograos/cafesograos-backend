const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'alberto.adm@cafesograos.com';
// Até o domínio cafesograos.com.br ser verificado no Resend (resend.com/domains),
// usamos o remetente padrão deles, que funciona sem verificação.
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'Café Só Grãos <onboarding@resend.dev>';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function enviarEmailNovoPedido(order) {
  if (!RESEND_API_KEY) {
    console.warn('AVISO: RESEND_API_KEY não definido. E-mail de pedido não enviado.');
    return;
  }

  const itensHtml = (order.items || [])
    .map((i) => `<li>${escapeHtml(i.quantity)}x ${escapeHtml(i.title)} — R$ ${Number(i.unit_price).toFixed(2)}</li>`)
    .join('');

  const html = `
    <h2>Novo pedido pago — Café Só Grãos</h2>
    <p><strong>Cliente:</strong> ${escapeHtml(order.customer_name)} (${escapeHtml(order.customer_email)}, ${escapeHtml(order.customer_phone || 'sem telefone')})</p>
    <p><strong>Endereço de entrega:</strong><br>
      ${escapeHtml(order.address)}, ${escapeHtml(order.address_number)} ${escapeHtml(order.address_complement || '')}<br>
      ${escapeHtml(order.neighborhood)} — ${escapeHtml(order.city)}/${escapeHtml(order.state)}<br>
      CEP: ${escapeHtml(order.cep)}
    </p>
    <p><strong>Itens:</strong></p>
    <ul>${itensHtml}</ul>
    <p><strong>Frete:</strong> R$ ${Number(order.shipping_cost).toFixed(2)}</p>
    <p><strong>Total:</strong> R$ ${Number(order.total).toFixed(2)}</p>
    <p><strong>ID da preferência:</strong> ${escapeHtml(order.preference_id)}</p>
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [NOTIFY_EMAIL],
      subject: `Novo pedido — ${order.customer_name} — R$ ${Number(order.total).toFixed(2)}`,
      html
    })
  });

  if (!res.ok) {
    const body = await res.text();
    console.error('Erro ao enviar e-mail via Resend:', res.status, body);
  } else {
    console.log('E-mail de novo pedido enviado para', NOTIFY_EMAIL);
  }
}

module.exports = { enviarEmailNovoPedido };
