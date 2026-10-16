// Checkboxes "já dei entrada"/"já entrei em contato" do painel admin: em vez
// de recarregar a página inteira (o que sempre causa um salto visual, mesmo
// voltando pro mesmo card), manda a marcação por baixo dos panos e só troca
// a cor do card na hora — a tela nunca se mexe.
document.addEventListener('change', (e) => {
  const checkbox = e.target;
  if (checkbox.type !== 'checkbox') return;
  const form = checkbox.closest('form.pedido-entrada');
  if (!form) return;

  checkbox.disabled = true;
  const body = new URLSearchParams(new FormData(form));
  fetch(form.action, { method: 'POST', body })
    .then((res) => {
      if (!res.ok) throw new Error('status ' + res.status);
      form.classList.toggle('marcada');
    })
    .catch(() => {
      // Rede falhou — volta ao jeito antigo (recarrega a página) pra garantir
      // que a marcação não se perca.
      form.submit();
    })
    .finally(() => { checkbox.disabled = false; });
});

// Painel do vendedor (montar pedido pro cliente): mostra o subtotal dos
// produtos escolhidos (sem frete, que só o servidor calcula de verdade) e
// pede confirmação antes de gerar o link — pra pegar na hora um "50" que
// devia ser "1" antes de virar um link de pagamento de R$1.600 por engano.
document.addEventListener('submit', (e) => {
  const form = e.target;
  if (form.id !== 'formNovoPedido') return;

  const qtds = form.querySelectorAll('input[type=number][data-preco]');
  let subtotal = 0;
  qtds.forEach((input) => {
    subtotal += (parseInt(input.value, 10) || 0) * Number(input.dataset.preco);
  });
  const desconto = Number(form.querySelector('#desconto')?.value) || 0;
  if (desconto > 0) subtotal = subtotal * (1 - desconto / 100);

  const valorFormatado = 'R$ ' + subtotal.toFixed(2).replace('.', ',');
  if (!confirm(`Confirma o pedido? Subtotal dos produtos (sem frete): ${valorFormatado}`)) {
    e.preventDefault();
  }
});
