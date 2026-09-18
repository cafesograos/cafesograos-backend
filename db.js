const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDb() {
  if (!pool) {
    console.warn('AVISO: DATABASE_URL não está definido. Pedidos não serão salvos.');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS melhorenvio_tokens (
      id SERIAL PRIMARY KEY,
      access_token TEXT,
      refresh_token TEXT,
      expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      preference_id TEXT UNIQUE,
      payment_id TEXT,
      status TEXT DEFAULT 'pending',
      customer_name TEXT,
      customer_email TEXT,
      customer_phone TEXT,
      cep TEXT,
      address TEXT,
      address_number TEXT,
      address_complement TEXT,
      neighborhood TEXT,
      city TEXT,
      state TEXT,
      items JSONB,
      shipping_cost NUMERIC,
      total NUMERIC,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // Pedido já existia sem essa coluna em produção — ADD COLUMN IF NOT EXISTS
  // garante que o campo apareça sem precisar recriar a tabela.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_code TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS free_gift BOOLEAN DEFAULT false;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_id INTEGER;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_percent NUMERIC;`);
  // Marcação manual do admin: "já lancei esse pedido no meu sistema de
  // vendas/contabilidade" — independente do status de pagamento/rastreio.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS entrada_sistema BOOLEAN DEFAULT false;`);
  // Qual transportadora/modalidade a Melhor Envio escolheu como mais barata
  // pra esse pedido — sem isso, na hora de gerar a etiqueta de verdade era
  // preciso recalcular o frete manualmente só pra descobrir qual usar.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_carrier TEXT;`);
  // Id do serviço cotado na Melhor Envio (ex.: 4 = Jadlog .Package) — precisa
  // ser o mesmo serviço na hora de comprar a etiqueta de verdade, senão o
  // preço/prazo real pode não bater com o que foi cobrado do cliente.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_service_id INTEGER;`);
  // Peso total (kg) usado na cotação — guardado pra reutilizar exatamente o
  // mesmo valor ao montar o volume na hora de comprar a etiqueta (os itens
  // salvos não guardam o id do produto, só título/quantidade/preço, então não
  // dava pra recalcular o peso com segurança a partir do pedido já salvo).
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_weight_kg NUMERIC;`);
  // CPF do cliente — passou a ser guardado (pedidos antigos ficam sem) só
  // porque a Melhor Envio exige o documento do destinatário pra emitir a
  // etiqueta. Não é mais descartado após a validação do checkout como antes;
  // a política de privacidade do site foi atualizada pra refletir isso.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_cpf TEXT;`);
  // Id do item no carrinho/pedido da Melhor Envio depois de inserido — usado
  // nas chamadas seguintes (pagar, gerar etiqueta, imprimir, rastrear).
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS melhorenvio_order_id TEXT;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id SERIAL PRIMARY KEY,
      customer_name TEXT NOT NULL,
      rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS product_line TEXT;`);

  // Cupom de 5% gerado após a primeira compra aprovada, válido por 30 dias,
  // aplicado automaticamente pelo e-mail do cliente na próxima compra.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discounts (
      id SERIAL PRIMARY KEY,
      customer_email TEXT NOT NULL,
      percent NUMERIC NOT NULL DEFAULT 5,
      created_at TIMESTAMPTZ DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ
    );
  `);

  // Contatos captados pelo formulário "deixe seu e-mail/WhatsApp" — gente que
  // visitou o site mas ainda não comprou. E-mail normalizado (minúsculo, sem
  // espaço) e único, pra não duplicar quem preenche o formulário de novo.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      name TEXT,
      email TEXT NOT NULL UNIQUE,
      phone TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Sem esses índices, cada checkout novo (checagem de primeira compra) e
  // cada carregamento do painel admin fazem varredura completa da tabela de
  // pedidos — hoje ainda rápido pelo volume baixo, mas silenciosamente mais
  // lento a cada pedido novo. Índice funcional em lower(trim(...)) porque é
  // exatamente essa expressão que a consulta de primeira compra usa.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_email_norm ON orders (lower(trim(customer_email)));`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders (customer_phone);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_discounts_email_norm ON discounts (lower(trim(customer_email)));`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews (status);`);

  console.log('Banco de dados pronto (tabelas orders, reviews, discounts, leads).');
}

module.exports = { pool, initDb };
