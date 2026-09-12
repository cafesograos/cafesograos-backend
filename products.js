// Catálogo de produtos — fonte única de verdade (preço, nome, peso).
// Servido ao frontend via GET /api/produtos e usado para validar o preço
// real de cada item em /api/create-preference (nunca confiamos no preço
// que o cliente manda). Campos "_en"/"_es" são só pra exibição (o site
// troca de idioma no navegador) — preço, peso e id continuam únicos.
const CATEGORIES = [
  { id: 'grao', nome: 'Café em Grão', nome_en: 'Whole Bean Coffee', nome_es: 'Café en Grano', nome_fr: 'Café en Grains' },
  { id: 'moido', nome: 'Café Moído', nome_en: 'Ground Coffee', nome_es: 'Café Molido', nome_fr: 'Café Moulu' },
  { id: 'drip', nome: 'Drip Coffee', nome_en: 'Drip Coffee', nome_es: 'Drip Coffee', nome_fr: 'Drip Coffee' }
];

const PRODUCTS = [
  {
    id: 'cafe-tradicional-500-moido',
    nome: 'Café Tradicional 500g',
    nome_en: 'Traditional Coffee 500g',
    nome_es: 'Café Tradicional 500g',
    nome_fr: 'Café Traditionnel 500g',
    descricao: 'O parceiro do seu dia a dia: torra encorpada, para um café forte e constante, sem perder a qualidade. 100% arábica, moído. 500g.',
    descricao_en: 'Your everyday companion: a full-bodied roast for a strong, consistent coffee without sacrificing quality. 100% arabica, ground. 500g.',
    descricao_es: 'El compañero de tu día a día: tueste con cuerpo, para un café fuerte y constante, sin perder calidad. 100% arábica, molido. 500g.',
    descricao_fr: 'Le compagnon de votre quotidien : torréfaction corsée, pour un café fort et constant, sans perdre en qualité. 100% arabica, moulu. 500g.',
    preco: 32.01,
    precoOriginal: 33.00,
    categoria: 'moido',
    pesoGramas: 550,
    img: 'assets/produto-tradicional-500.jpg',
    imgs: ['assets/produto-tradicional-500.jpg', 'assets/produto-tradicional-500-2.jpg']
  },
  {
    id: 'cafe-gourmet-500-moido',
    nome: 'Café Gourmet 500g — Moído',
    nome_en: 'Gourmet Coffee 500g — Ground',
    nome_es: 'Café Gourmet 500g — Molido',
    nome_fr: 'Café Gourmet 500g — Moulu',
    descricao: 'Nossa linha Oro Brasiliano: grãos selecionados a dedo, torra média e acidez equilibrada — um upgrade de sabor na sua xícara. 100% arábica, moído. 500g.',
    descricao_en: 'Our Oro Brasiliano line: hand-picked beans, medium roast and balanced acidity — a flavor upgrade for your cup. 100% arabica, ground. 500g.',
    descricao_es: 'Nuestra línea Oro Brasiliano: granos seleccionados a mano, tueste medio y acidez equilibrada — una mejora de sabor en tu taza. 100% arábica, molido. 500g.',
    descricao_fr: 'Notre ligne Oro Brasiliano : grains triés à la main, torréfaction moyenne et acidité équilibrée — une montée en saveur dans votre tasse. 100% arabica, moulu. 500g.',
    preco: 47.00,
    precoOriginal: 55.00,
    categoria: 'moido',
    pesoGramas: 550,
    img: 'assets/produto-gourmet-oro-brasiliano.jpg',
    imgs: ['assets/produto-gourmet-oro-brasiliano.jpg', 'assets/produto-gourmet-oro-brasiliano-rotulo.jpg']
  },
  {
    id: 'cafe-especial-500-grao',
    nome: 'Café Especial 500g — Grãos',
    nome_en: 'Specialty Coffee 500g — Whole Beans',
    nome_es: 'Café Especial 500g — En Grano',
    nome_fr: 'Café Spécial 500g — En Grains',
    descricao: 'Nosso café mais sofisticado: acima de 80 pontos numa escala internacional (SCA), com xícara limpa e notas aromáticas complexas. 100% arábica, em grãos. 500g.',
    descricao_en: 'Our most sophisticated coffee: scoring above 80 points on an international scale (SCA), with a clean cup and complex aromatic notes. 100% arabica, whole beans. 500g.',
    descricao_es: 'Nuestro café más sofisticado: por encima de 80 puntos en una escala internacional (SCA), con taza limpia y notas aromáticas complejas. 100% arábica, en grano. 500g.',
    descricao_fr: 'Notre café le plus sophistiqué : plus de 80 points sur une échelle internationale (SCA), avec une tasse nette et des notes aromatiques complexes. 100% arabica, en grains. 500g.',
    preco: 60.00,
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
    nome_en: 'Specialty Coffee 500g — Ground',
    nome_es: 'Café Especial 500g — Molido',
    nome_fr: 'Café Spécial 500g — Moulu',
    descricao: 'Nosso café mais sofisticado: acima de 80 pontos numa escala internacional (SCA), com xícara limpa e notas aromáticas complexas. 100% arábica, moído. 500g.',
    descricao_en: 'Our most sophisticated coffee: scoring above 80 points on an international scale (SCA), with a clean cup and complex aromatic notes. 100% arabica, ground. 500g.',
    descricao_es: 'Nuestro café más sofisticado: por encima de 80 puntos en una escala internacional (SCA), con taza limpia y notas aromáticas complejas. 100% arábica, molido. 500g.',
    descricao_fr: 'Notre café le plus sophistiqué : plus de 80 points sur une échelle internationale (SCA), avec une tasse nette et des notes aromatiques complexes. 100% arabica, moulu. 500g.',
    preco: 60.00,
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
    nome_en: 'Drip Coffee',
    nome_es: 'Drip Coffee',
    nome_fr: 'Drip Coffee',
    descricao: 'Café coado sem complicação: a praticidade do sachê individual, sem abrir mão do sabor. 100% arábica. Caixa com 10 unidades.',
    descricao_en: 'Hassle-free filter coffee: the convenience of an individual sachet, without giving up flavor. 100% arabica. Box of 10.',
    descricao_es: 'Café filtrado sin complicaciones: la practicidad del sobre individual, sin renunciar al sabor. 100% arábica. Caja con 10 unidades.',
    descricao_fr: 'Du café filtre sans complication : la praticité du sachet individuel, sans renoncer à la saveur. 100% arabica. Boîte de 10 unités.',
    preco: 83.70,
    precoOriginal: 90.00,
    categoria: 'drip',
    pesoGramas: 400,
    img: 'assets/produto-drip-coffee.jpg',
    imgs: ['assets/produto-drip-coffee.jpg', 'assets/produto-drip-coffee-rotulo.jpg']
  }
];

module.exports = { CATEGORIES, PRODUCTS };
