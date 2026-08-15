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
  console.log('Banco de dados pronto (tabelas orders, reviews).');
}

module.exports = { pool, initDb };
