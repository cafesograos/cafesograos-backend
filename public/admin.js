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
