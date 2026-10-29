// Catálogo de produtos — fonte única de verdade (preço, nome, peso).
// Servido ao frontend via GET /api/produtos e usado para validar o preço
// real de cada item em /api/create-preference (nunca confiamos no preço
// que o cliente manda). Campos "_en"/"_es" são só pra exibição (o site
// troca de idioma no navegador) — preço, peso e id continuam únicos.
const CATEGORIES = [
  { id: 'grao', nome: 'Café em Grão', nome_en: 'Whole Bean Coffee', nome_es: 'Café en Grano', nome_fr: 'Café en Grains', nome_zh: '咖啡豆' },
  { id: 'moido', nome: 'Café Moído', nome_en: 'Ground Coffee', nome_es: 'Café Molido', nome_fr: 'Café Moulu', nome_zh: '咖啡粉' },
  { id: 'drip', nome: 'Drip Coffee', nome_en: 'Drip Coffee', nome_es: 'Drip Coffee', nome_fr: 'Drip Coffee', nome_zh: 'Drip Coffee' }
];

const PRODUCTS = [
  {
    id: 'cafe-tradicional-500-moido',
    nome: 'Café Tradicional 500g',
    nome_en: 'Traditional Coffee 500g',
    nome_es: 'Café Tradicional 500g',
    nome_fr: 'Café Traditionnel 500g',
    nome_zh: '传统咖啡 500g',
    descricao: 'O parceiro do seu dia a dia: torra encorpada, para um café forte e constante, sem perder a qualidade. 100% arábica, moído. 500g.',
    descricao_en: 'Your everyday companion: a full-bodied roast for a strong, consistent coffee without sacrificing quality. 100% arabica, ground. 500g.',
    descricao_es: 'El compañero de tu día a día: tueste con cuerpo, para un café fuerte y constante, sin perder calidad. 100% arábica, molido. 500g.',
    descricao_fr: 'Le compagnon de votre quotidien : torréfaction corsée, pour un café fort et constant, sans perdre en qualité. 100% arabica, moulu. 500g.',
    descricao_zh: '您日常生活的伙伴：浓郁醇厚的烘焙，带来强劲稳定的口感，品质毫不妥协。100%阿拉比卡，研磨咖啡。500g。',
    preco: 32.01,
    precoOriginal: 33.00,
    categoria: 'moido',
    pesoGramas: 550,
    img: 'assets/produto-tradicional-500.jpg',
    imgs: ['assets/produto-tradicional-500.jpg']
  },
  {
    id: 'cafe-especial-500-grao',
    nome: 'Café Especial 500g — Grãos',
    nome_en: 'Specialty Coffee 500g — Whole Beans',
    nome_es: 'Café Especial 500g — En Grano',
    nome_fr: 'Café Spécial 500g — En Grains',
    nome_zh: '特级咖啡 500g — 咖啡豆',
    descricao: 'Nosso café mais sofisticado: 84 pontos na escala SCA, avaliado pela Coopercitrus. Aroma de caramelo, chocolate e nozes, com sabor de chocolate ao leite, caramelo e nozes — acidez média baixa, corpo médio alto e finalização média alta. 100% arábica, em grãos. 500g.',
    descricao_en: 'Our most sophisticated coffee: 84 points on the SCA scale, rated by Coopercitrus. Aroma of caramel, chocolate and nuts, with a flavor of milk chocolate, caramel and nuts — medium-low acidity, medium-high body and medium-high finish. 100% arabica, whole beans. 500g.',
    descricao_es: 'Nuestro café más sofisticado: 84 puntos en la escala SCA, evaluado por Coopercitrus. Aroma a caramelo, chocolate y nueces, con sabor a chocolate con leche, caramelo y nueces — acidez media baja, cuerpo medio alto y final medio alto. 100% arábica, en grano. 500g.',
    descricao_fr: 'Notre café le plus sophistiqué : 84 points sur l’échelle SCA, évalué par la Coopercitrus. Arômes de caramel, chocolat et noix, avec une saveur de chocolat au lait, caramel et noix — acidité moyenne-faible, corps moyen-élevé et une finale moyenne-élevée. 100% arabica, en grains. 500g.',
    descricao_zh: '我们最精致的咖啡：SCA评分体系84分，经Coopercitrus合作社评定。香气带有焦糖、巧克力与坚果的气息，口感呈现牛奶巧克力、焦糖与坚果风味——酸度中低，醇厚度中高，余韵绵长浓郁。100%阿拉比卡，咖啡豆。500g。',
    preco: 55.00,
    precoOriginal: 60.00,
    categoria: 'grao',
    badge: '84 SCA',
    pesoGramas: 550,
    img: 'assets/produto-especial-500.jpg',
    imgs: ['assets/produto-especial-500.jpg', 'assets/laudo-cafe-especial.jpg']
  },
  {
    id: 'cafe-especial-500-moido',
    nome: 'Café Especial 500g — Moído',
    nome_en: 'Specialty Coffee 500g — Ground',
    nome_es: 'Café Especial 500g — Molido',
    nome_fr: 'Café Spécial 500g — Moulu',
    nome_zh: '特级咖啡 500g — 研磨',
    descricao: 'Nosso café mais sofisticado: 84 pontos na escala SCA, avaliado pela Coopercitrus. Aroma de caramelo, chocolate e nozes, com sabor de chocolate ao leite, caramelo e nozes — acidez média baixa, corpo médio alto e finalização média alta. 100% arábica, moído. 500g.',
    descricao_en: 'Our most sophisticated coffee: 84 points on the SCA scale, rated by Coopercitrus. Aroma of caramel, chocolate and nuts, with a flavor of milk chocolate, caramel and nuts — medium-low acidity, medium-high body and medium-high finish. 100% arabica, ground. 500g.',
    descricao_es: 'Nuestro café más sofisticado: 84 puntos en la escala SCA, evaluado por Coopercitrus. Aroma a caramelo, chocolate y nueces, con sabor a chocolate con leche, caramelo y nueces — acidez media baja, cuerpo medio alto y final medio alto. 100% arábica, molido. 500g.',
    descricao_fr: 'Notre café le plus sophistiqué : 84 points sur l’échelle SCA, évalué par la Coopercitrus. Arômes de caramel, chocolat et noix, avec une saveur de chocolat au lait, caramel et noix — acidité moyenne-faible, corps moyen-élevé et une finale moyenne-élevée. 100% arabica, moulu. 500g.',
    descricao_zh: '我们最精致的咖啡：SCA评分体系84分，经Coopercitrus合作社评定。香气带有焦糖、巧克力与坚果的气息，口感呈现牛奶巧克力、焦糖与坚果风味——酸度中低，醇厚度中高，余韵绵长浓郁。100%阿拉比卡，研磨咖啡。500g。',
    preco: 55.00,
    precoOriginal: 60.00,
    categoria: 'moido',
    badge: '84 SCA',
    pesoGramas: 550,
    img: 'assets/produto-especial-500.jpg',
    imgs: ['assets/produto-especial-500.jpg', 'assets/laudo-cafe-especial.jpg']
  },
  {
    id: 'drip-coffee-caixa-10',
    nome: 'Drip Coffee',
    nome_en: 'Drip Coffee',
    nome_es: 'Drip Coffee',
    nome_fr: 'Drip Coffee',
    nome_zh: 'Drip Coffee',
    descricao: 'Café coado sem complicação: a praticidade do sachê individual, sem abrir mão do sabor. 100% arábica. Caixa com 10 unidades.',
    descricao_en: 'Hassle-free filter coffee: the convenience of an individual sachet, without giving up flavor. 100% arabica. Box of 10.',
    descricao_es: 'Café filtrado sin complicaciones: la practicidad del sobre individual, sin renunciar al sabor. 100% arábica. Caja con 10 unidades.',
    descricao_fr: 'Du café filtre sans complication : la praticité du sachet individuel, sans renoncer à la saveur. 100% arabica. Boîte de 10 unités.',
    descricao_zh: '无需繁琐步骤的挂耳咖啡：独立小包装带来便利，风味丝毫不打折扣。100%阿拉比卡。一盒10包。',
    preco: 65.99,
    precoOriginal: 90.00,
    categoria: 'drip',
    pesoGramas: 400,
    img: 'assets/produto-drip-coffee.jpg',
    imgs: ['assets/produto-drip-coffee.jpg', 'assets/produto-drip-coffee-rotulo.jpg']
  },
  {
    id: 'caixa-drip-coffee-vazia',
    nome: 'Caixa do Drip Coffee (vazia)',
    nome_en: 'Drip Coffee Box (empty)',
    nome_es: 'Caja del Drip Coffee (vacía)',
    nome_fr: 'Boîte du Drip Coffee (vide)',
    nome_zh: 'Drip Coffee 收纳盒（空盒）',
    descricao: 'Só a caixa organizadora do nosso Drip Coffee, vendida vazia — sem os sachês de café dentro. Pra quem já tem e quer repor ou só precisa dela pra guardar as coisas.',
    descricao_en: 'Just the organizer box from our Drip Coffee, sold empty — without the coffee sachets inside. For anyone who already has one and wants a replacement, or just needs it for storage.',
    descricao_es: 'Solo la caja organizadora de nuestro Drip Coffee, vendida vacía — sin los sobres de café dentro. Para quien ya tiene una y quiere reponerla, o solo la necesita para guardar cosas.',
    descricao_fr: 'Juste la boîte organisatrice de notre Drip Coffee, vendue vide — sans les sachets de café à l\'intérieur. Pour qui en a déjà une et veut la remplacer, ou en a simplement besoin pour du rangement.',
    descricao_zh: '仅为我们Drip Coffee的收纳盒，空盒出售——不含咖啡包。适合已有产品想补充盒子，或只是需要用它来收纳物品的您。',
    preco: 20.00,
    categoria: 'drip',
    pesoGramas: 50,
    img: 'assets/produto-drip-coffee.jpg',
    imgs: ['assets/produto-drip-coffee.jpg']
  },
  {
    id: 'drip-coffee-unidade',
    nome: 'Drip Coffee — Unidade',
    nome_en: 'Drip Coffee — Single Sachet',
    nome_es: 'Drip Coffee — Unidad',
    nome_fr: 'Drip Coffee — Sachet Individuel',
    nome_zh: 'Drip Coffee — 单包装',
    descricao: 'Experimente antes de levar a caixa: 1 sachê individual de café coado, prático e saboroso. 100% arábica.',
    descricao_en: 'Try it before you commit to the box: 1 individual filter coffee sachet, convenient and full of flavor. 100% arabica.',
    descricao_es: 'Pruébalo antes de llevar la caja: 1 sobre individual de café filtrado, práctico y sabroso. 100% arábica.',
    descricao_fr: 'Essayez avant la boîte : 1 sachet individuel de café filtre, pratique et savoureux. 100% arabica.',
    descricao_zh: '在购买整盒前先试试看：1包独立装挂耳咖啡，方便又美味。100%阿拉比卡。',
    preco: 6.00,
    precoOriginal: 8.00,
    categoria: 'drip',
    pesoGramas: 30,
    img: 'assets/produto-drip-coffee.jpg',
    imgs: ['assets/produto-drip-coffee.jpg']
  }
];

module.exports = { CATEGORIES, PRODUCTS };
