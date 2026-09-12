const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'alberto.adm@cafesograos.com.br';
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'Café Só Grãos <onboarding@resend.dev>';
const LOGO_URL = 'https://www.cafesograos.com.br/assets/logo.jpg';

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

function reais(v) {
  return 'R$ ' + Number(v).toFixed(2).replace('.', ',');
}

function itensHtml(order) {
  return (order.items || [])
    .map((i) => `<li>${escapeHtml(i.quantity)}x ${escapeHtml(i.title)} — ${reais(i.unit_price)}</li>`)
    .join('');
}

// Moldura visual (logo + rodapé de marca) usada em todo e-mail que vai pro
// cliente — pra quem compra pela primeira vez sentir que é um negócio de
// verdade, não um golpe. E-mail interno de notificação de pedido (pro
// admin) não usa isso, é só informativo mesmo.
function emailCliente(conteudoHtml) {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body style="margin:0;padding:0;background:#F7F5F4;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F5F4;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;">
            <tr>
              <td align="center" style="padding:28px 24px 12px;">
                <img src="${LOGO_URL}" alt="Café Só Grãos" width="84" height="84" style="border-radius:50%;display:block;">
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 32px;color:#211714;font-size:15px;line-height:1.6;">
                ${conteudoHtml}
              </td>
            </tr>
            <tr>
              <td style="background:#211714;padding:20px 32px;color:rgba(255,255,255,.75);font-size:12px;text-align:center;line-height:1.8;">
                Café Só Grãos · Araraquara/SP<br>
                <a href="https://wa.me/5516997616459" style="color:#D66B3E;text-decoration:none;">WhatsApp (16) 99761-6459</a>
                &nbsp;·&nbsp;
                <a href="mailto:contato@cafesograos.com.br" style="color:#D66B3E;text-decoration:none;">contato@cafesograos.com.br</a><br>
                <a href="https://www.cafesograos.com.br/privacidade.html" style="color:rgba(255,255,255,.55);text-decoration:none;">Política de Privacidade</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;
}

function caixaDestaque(html) {
  return `<div style="background:#FBEEE7;border-left:4px solid #D66B3E;border-radius:8px;padding:14px 16px;margin:16px 0;">${html}</div>`;
}

// E-mail interno (pro admin), só informativo — não precisa da moldura de marca.
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
    <p><strong>Frete:</strong> ${Number(order.shipping_cost) === 0 ? 'Grátis' : reais(order.shipping_cost)}</p>
    <p><strong>Total:</strong> ${reais(order.total)}</p>
    <p><strong>ID da preferência:</strong> ${escapeHtml(order.preference_id)}</p>
  `;

  return enviarEmail({
    to: NOTIFY_EMAIL,
    subject: `Novo pedido — ${order.customer_name} — ${reais(order.total)}`,
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

  const conteudo = `
    <h2 style="font-size:22px;margin:0 0 12px;">Recebemos seu pedido! ☕</h2>
    <p>Oi, ${escapeHtml(order.customer_name)}! Seu pagamento foi aprovado, muito obrigado pela compra.</p>
    ${caixaDestaque(`
      <strong style="color:#B85A32;">Pode ficar tranquilo(a) ✅</strong><br>
      Seu pedido é de verdade e já está confirmado. Vamos torrar, embalar e despachar seu café em até <strong>1 dia útil</strong>. Assim que sair pra entrega, mandamos outro e-mail com o código de rastreio e o prazo estimado.
    `)}
    ${brindeHtml}
    ${descontoHtml}
    <p><strong>Número do pedido:</strong> ${escapeHtml(order.preference_id)}<br>
      <span style="color:#8a6f5c;font-size:13px;">Guarde esse número — é com ele que você consulta o status em <a href="https://www.cafesograos.com.br/rastreio.html" style="color:#D66B3E;">cafesograos.com.br/rastreio.html</a></span>
    </p>
    <p><strong>Itens do pedido:</strong></p>
    <ul>${itensHtml(order)}</ul>
    <p><strong>Frete:</strong> ${Number(order.shipping_cost) === 0 ? 'Grátis' : reais(order.shipping_cost)}</p>
    <p><strong>Total:</strong> ${reais(order.total)}</p>
    <p><strong>Endereço de entrega:</strong><br>
      ${escapeHtml(order.address)}, ${escapeHtml(order.address_number)} ${escapeHtml(order.address_complement || '')}<br>
      ${escapeHtml(order.neighborhood)} — ${escapeHtml(order.city)}/${escapeHtml(order.state)}<br>
      CEP: ${escapeHtml(order.cep)}
    </p>
    <p>Qualquer dúvida, é só responder este e-mail ou chamar no WhatsApp (16) 99761-6459.</p>
    <p>Obrigado por comprar conosco!<br>Café Só Grãos</p>
  `;

  return enviarEmail({
    to: order.customer_email,
    subject: 'Recebemos seu pedido — Café Só Grãos',
    html: emailCliente(conteudo)
  });
}

// Aviso de envio com código de rastreio, disparado manualmente pelo admin
// (painel /admin/pedidos) quando o pacote sai para entrega.
async function enviarEmailRastreio(order) {
  if (!order.customer_email || !order.tracking_code) return { ok: false, motivo: 'faltam e-mail ou código de rastreio' };

  const conteudo = `
    <h2 style="font-size:22px;margin:0 0 12px;">Seu pedido foi enviado! 📦</h2>
    <p>Oi, ${escapeHtml(order.customer_name)}! Seu café já está a caminho.</p>
    ${caixaDestaque(`<strong style="color:#B85A32;">Código de rastreio:</strong> ${escapeHtml(order.tracking_code)}`)}
    <p>Você pode acompanhar a entrega no site dos Correios ou da transportadora usando esse código.</p>
    <p>Qualquer dúvida, é só responder este e-mail ou chamar no WhatsApp (16) 99761-6459.</p>
    <p>Obrigado por comprar conosco!<br>Café Só Grãos</p>
  `;

  return enviarEmail({
    to: order.customer_email,
    subject: 'Seu pedido foi enviado — Café Só Grãos',
    html: emailCliente(conteudo)
  });
}

// Confirmação para quem deixou o contato no formulário "avise-me" do site,
// sem ter comprado ainda — reforça a oferta de primeira compra já anunciada
// no site, em vez de inventar um cupom novo e concorrente com ela.
async function enviarEmailBoasVindasLead(lead) {
  const conteudo = `
    <h2 style="font-size:22px;margin:0 0 12px;">Combinado! ☕</h2>
    <p>Oi${lead.name ? `, ${escapeHtml(lead.name)}` : ''}! Anotamos seu contato — assim que sair uma nova torra ou uma promoção, você fica sabendo antes de todo mundo.</p>
    <p>E já que você está aqui: na sua primeira compra você ganha um Drip Coffee de brinde e um cupom de 5% de desconto pra próxima. É só finalizar o pedido normalmente em <a href="https://www.cafesograos.com.br" style="color:#D66B3E;">cafesograos.com.br</a>.</p>
    <p>Qualquer dúvida, é só responder este e-mail ou chamar no WhatsApp (16) 99761-6459.</p>
    <p>Até já!<br>Café Só Grãos</p>
  `;

  return enviarEmail({
    to: lead.email,
    subject: 'Combinado — Café Só Grãos',
    html: emailCliente(conteudo)
  });
}

module.exports = { enviarEmailNovoPedido, enviarEmailConfirmacaoCliente, enviarEmailRastreio, enviarEmailBoasVindasLead };
