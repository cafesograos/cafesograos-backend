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
    descricao: 'Torra tradicional, equilibrada e encorpada. 100% arábica, moído. 500g.',
    preco: 33.00,
    categoria: 'moido',
    pesoGramas: 550,
    img: 'assets/produto-tradicional-500.jpg',
    imgs: ['assets/produto-tradicional-500.jpg', 'assets/logo.jpg']
  },
  {
    id: 'cafe-gourmet-250-grao',
    nome: 'Café Gourmet 250g — Grãos',
    descricao: 'Torra média, aroma marcante e acidez equilibrada. 100% arábica, em grãos. 250g.',
    preco: 30.00,
    categoria: 'grao',
    pesoGramas: 300,
    img: null
  },
  {
    id: 'cafe-gourmet-250-moido',
    nome: 'Café Gourmet 250g — Moído',
    descricao: 'Torra média, aroma marcante e acidez equilibrada. 100% arábica, moído. 250g.',
    preco: 30.00,
    categoria: 'moido',
    pesoGramas: 300,
    img: null
  },
  {
    id: 'cafe-gourmet-500-grao',
    nome: 'Café Gourmet 500g — Grãos',
    descricao: 'Torra média, aroma marcante e acidez equilibrada. 100% arábica, em grãos. 500g.',
    preco: 55.00,
    categoria: 'grao',
    pesoGramas: 550,
    img: null
  },
  {
    id: 'cafe-gourmet-500-moido',
    nome: 'Café Gourmet 500g — Moído',
    descricao: 'Torra média, aroma marcante e acidez equilibrada. 100% arábica, moído. 500g.',
    preco: 55.00,
    categoria: 'moido',
    pesoGramas: 550,
    img: null
  },
  {
    id: 'cafe-especial-250-grao',
    nome: 'Café Especial 250g — Grãos',
    descricao: 'Nota 83+ SCA. Torra clara a média, xícara limpa e notas sensoriais complexas. 100% arábica, em grãos. 250g.',
    preco: 50.00,
    categoria: 'grao',
    badge: '83+ SCA',
    pesoGramas: 300,
    img: null
  },
  {
    id: 'cafe-especial-250-moido',
    nome: 'Café Especial 250g — Moído',
    descricao: 'Nota 83+ SCA. Torra clara a média, xícara limpa e notas sensoriais complexas. 100% arábica, moído. 250g.',
    preco: 50.00,
    categoria: 'moido',
    badge: '83+ SCA',
    pesoGramas: 300,
    img: null
  },
  {
    id: 'cafe-especial-500-grao',
    nome: 'Café Especial 500g — Grãos',
    descricao: 'Nota 83+ SCA. Torra clara a média, xícara limpa e notas sensoriais complexas. 100% arábica, em grãos. 500g.',
    preco: 70.00,
    categoria: 'grao',
    badge: '83+ SCA',
    pesoGramas: 550,
    img: null
  },
  {
    id: 'cafe-especial-500-moido',
    nome: 'Café Especial 500g — Moído',
    descricao: 'Nota 83+ SCA. Torra clara a média, xícara limpa e notas sensoriais complexas. 100% arábica, moído. 500g.',
    preco: 70.00,
    categoria: 'moido',
    badge: '83+ SCA',
    pesoGramas: 550,
    img: null
  },
  {
    id: 'drip-coffee-caixa-10',
    nome: 'Drip Coffee',
    descricao: 'Café coado individual, praticidade sem perder o sabor. 100% arábica. Caixa com 10 sachês.',
    preco: 90.00,
    categoria: 'drip',
    pesoGramas: 400,
    img: null
  }
];

module.exports = { CATEGORIES, PRODUCTS };
