// Busca nos cards de pedidos/contatos do painel admin — filtra pelo texto
// guardado em data-busca de cada card (nome, e-mail, telefone, id), ignorando
// acento e maiuscula/minuscula. Um unico arquivo reusado em todas as paginas
// que tiverem um campo #buscaLista.
function normalizarBusca(valor) {
  return (valor || '')
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

document.addEventListener('input', (e) => {
  if (e.target.id !== 'buscaLista') return;
  const termo = normalizarBusca(e.target.value);
  const cards = document.querySelectorAll('[data-busca]');
  let visiveis = 0;
  cards.forEach((card) => {
    const bate = normalizarBusca(card.dataset.busca).includes(termo);
    card.style.display = bate ? '' : 'none';
    if (bate) visiveis++;
  });
  const avisoVazio = document.getElementById('buscaSemResultado');
  if (avisoVazio) avisoVazio.hidden = visiveis > 0 || !termo;
});
