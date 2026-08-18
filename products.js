// Catálogo de produtos — fonte única de verdade (preço, nome, peso).
// Servido ao frontend via GET /api/produtos e usado para validar o preço
// real de cada item em /api/create-preference (nunca confiamos no preço
// que o cliente manda).
const CATEGORIES = [
  { id: 'grao', nome: 'Café em Grão' },
  { id: 'moido', nome: 'Café Moído' },
  { id: 'drip', nome: 'Drip Coffee' }
];

const PRODUCTS = [
  {
    id: 'cafe-tradicional-500-moido',
    nome: 'Café Tradicional 500g',
    descricao: 'O parceiro do seu dia a dia: torra encorpada, para um café forte e constante, sem perder a qualidade. 100% arábica, moído. 500g.',
    preco: 32.01,
    precoOriginal: 33.00,
    categoria: 'moido',
    pesoGramas: 550,
    img: 'assets/produto-tradicional-500.jpg',
    imgs: ['assets/produto-tradicional-500.jpg', 'assets/produto-tradicional-500-2.jpg']
  },
  {
    id: 'cafe-gourmet-500-grao',
    nome: 'Café Gourmet 500g — Grãos',
    descricao: 'Nossa linha Oro Brasiliano: grãos selecionados a dedo, torra média e acidez equilibrada — um upgrade de sabor na sua xícara. 100% arábica, em grãos. 500g.',
    preco: 53.35,
    precoOriginal: 55.00,
    categoria: 'grao',
    pesoGramas: 550,
    img: 'assets/produto-gourmet-oro-brasiliano.jpg',
    imgs: ['assets/produto-gourmet-oro-brasiliano.jpg', 'assets/produto-gourmet-oro-brasiliano-rotulo.jpg']
  },
  {
    id: 'cafe-gourmet-500-moido',
    nome: 'Café Gourmet 500g — Moído',
    descricao: 'Nossa linha Oro Brasiliano: grãos selecionados a dedo, torra média e acidez equilibrada — um upgrade de sabor na sua xícara. 100% arábica, moído. 500g.',
    preco: 53.35,
    precoOriginal: 55.00,
    categoria: 'moido',
    pesoGramas: 550,
    img: 'assets/produto-gourmet-oro-brasiliano.jpg',
    imgs: ['assets/produto-gourmet-oro-brasiliano.jpg', 'assets/produto-gourmet-oro-brasiliano-rotulo.jpg']
  },
  {
    id: 'cafe-especial-500-grao',
    nome: 'Café Especial 500g — Grãos',
    descricao: 'Nosso café mais sofisticado: acima de 80 pontos numa escala internacional (SCA), com xícara limpa e notas aromáticas complexas. 100% arábica, em grãos. 500g.',
    preco: 67.90,
    precoOriginal: 70.00,
    categoria: 'grao',
    badge: '83+ SCA',
    pesoGramas: 550,
    img: 'assets/produto-gourmet-oro-brasiliano.jpg',
    imgs: ['assets/produto-gourmet-oro-brasiliano.jpg', 'assets/produto-gourmet-oro-brasiliano-rotulo.jpg']
  },
  {
    id: 'cafe-especial-500-moido',
    nome: 'Café Especial 500g — Moído',
    descricao: 'Nosso café mais sofisticado: acima de 80 pontos numa escala internacional (SCA), com xícara limpa e notas aromáticas complexas. 100% arábica, moído. 500g.',
    preco: 67.90,
    precoOriginal: 70.00,
    categoria: 'moido',
    badge: '83+ SCA',
    pesoGramas: 550,
    img: 'assets/produto-gourmet-oro-brasiliano.jpg',
    imgs: ['assets/produto-gourmet-oro-brasiliano.jpg', 'assets/produto-gourmet-oro-brasiliano-rotulo.jpg']
  },
  {
    id: 'drip-coffee-caixa-10',
    nome: 'Drip Coffee',
    descricao: 'Café coado sem complicação: a praticidade do sachê individual, sem abrir mão do sabor. 100% arábica. Caixa com 10 unidades.',
    preco: 83.70,
    precoOriginal: 90.00,
    categoria: 'drip',
    pesoGramas: 400,
    img: 'assets/produto-drip-coffee.jpg',
    imgs: ['assets/produto-drip-coffee.jpg', 'assets/produto-drip-coffee-rotulo.jpg']
  }
];

module.exports = { CATEGORIES, PRODUCTS };
