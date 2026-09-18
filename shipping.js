const { pool } = require('./db');

const ORIGEM_CEP = '14800360';
const ME_BASE = 'https://melhorenvio.com.br';
const FALLBACK_POR_KG = 22; // usado só se a integração com o Melhor Envio estiver fora do ar

// Sem informar "services" na cotação, a API só retorna a Loggi Ponto (id 34),
// mesmo com Correios, Jadlog e Total Express disponíveis e habilitados na
// conta — o site cotava só a Loggi sem nenhum erro aparecer, escondendo opções
// mais baratas (Jadlog) e nunca refletindo o Correios de verdade. Por isso a
// lista de serviços é buscada da própria conta (nunca fixa no código): se um
// serviço novo for habilitado ou um antigo cair, o cálculo acompanha sozinho.
// Lista de reserva (1/2/17=Correios, 3/4/27=Jadlog, 31/32/34=Loggi, 35=Total
// Express), usada só se a busca da lista de serviços falhar.
const SERVICOS_FALLBACK = '1,2,3,4,17,27,31,32,34,35';
let servicosCache = null;
let servicosCacheExpiraEm = 0;

async function getServicosHabilitados(token) {
  if (servicosCache && Date.now() < servicosCacheExpiraEm) return servicosCache;
  try {
    const res = await fetch(`${ME_BASE}/api/v2/me/shipment/services`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'Cafe So Graos (alberto.adm@cafesograos.com)'
      }
    });
    if (!res.ok) throw new Error('status ' + res.status);
    const lista = await res.json();
    const ids = lista
      .filter((s) => s.status === 'available' && s.company?.status === 'available')
      .map((s) => s.id);
    if (ids.length === 0) throw new Error('lista de serviços veio vazia');
    servicosCache = ids.join(',');
    servicosCacheExpiraEm = Date.now() + 60 * 60 * 1000; // 1h — evita bater essa rota a cada cotação
    return servicosCache;
  } catch (err) {
    console.error('Falha ao listar serviços do Melhor Envio, usando lista de reserva:', err.message);
    return SERVICOS_FALLBACK;
  }
}

function limparCep(cep) {
  return String(cep || '').replace(/\D/g, '');
}

async function getValidToken() {
  if (!pool) throw new Error('Banco de dados não configurado.');
  const { rows } = await pool.query('SELECT * FROM melhorenvio_tokens ORDER BY id DESC LIMIT 1');
  const row = rows[0];
  if (!row) throw new Error('Melhor Envio ainda não foi autorizado. Acesse /oauth/melhorenvio/connect.');

  const expiraEm = new Date(row.expires_at).getTime();
  if (expiraEm - Date.now() > 60_000) {
    return row.access_token;
  }

  // Token expirado (ou perto disso): renova com o refresh_token.
  const res = await fetch(`${ME_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: process.env.MELHORENVIO_CLIENT_ID,
      client_secret: process.env.MELHORENVIO_CLIENT_SECRET,
      refresh_token: row.refresh_token
    })
  });
  if (!res.ok) throw new Error('Falha ao renovar token do Melhor Envio: ' + (await res.text()));
  const data = await res.json();

  const expires_at = new Date(Date.now() + data.expires_in * 1000);
  await pool.query(
    'UPDATE melhorenvio_tokens SET access_token=$1, refresh_token=$2, expires_at=$3, updated_at=now() WHERE id=$4',
    [data.access_token, data.refresh_token, expires_at, row.id]
  );
  return data.access_token;
}

async function calcularFrete(cepDestino, pesoKg) {
  const destino = limparCep(cepDestino);
  if (destino.length !== 8) throw new Error('CEP inválido.');
  const peso = Math.max(0.3, pesoKg || 0.3);

  try {
    const token = await getValidToken();
    const services = await getServicosHabilitados(token);
    const res = await fetch(`${ME_BASE}/api/v2/me/shipment/calculate`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'Cafe So Graos (alberto.adm@cafesograos.com)'
      },
      body: JSON.stringify({
        from: { postal_code: ORIGEM_CEP },
        to: { postal_code: destino },
        products: [
          { id: 'carrinho', width: 15, height: 10, length: 20, weight: peso, insurance_value: 50, quantity: 1 }
        ],
        options: { receipt: false, own_hand: false },
        services
      })
    });

    if (!res.ok) throw new Error('Melhor Envio retornou erro: ' + res.status);
    const corpo = await res.json();
    // Com "services" informado a API sempre devolve um array (um item por
    // serviço pedido, com "error" preenchido nos que não atenderem o CEP/peso).
    const opcoes = Array.isArray(corpo) ? corpo : [corpo];
    const validas = opcoes.filter((o) => o.price && !o.error);
    if (validas.length === 0) throw new Error('Nenhuma transportadora disponível pra esse CEP.');
    // Sinaliza no log se sobrar só 1 opção válida quando várias foram pedidas —
    // foi exatamente esse padrão silencioso (sem erro, só resultado incompleto)
    // que escondeu por meses que a Loggi era a única cotada de verdade.
    if (validas.length === 1 && opcoes.length > 1) {
      console.warn(`[frete] Só 1 de ${opcoes.length} transportadoras pedidas voltou com cotação válida pro CEP ${destino} — vale checar a integração com o Melhor Envio.`);
    }

    const maisBarata = validas.reduce((a, b) => (Number(a.custom_price || a.price) <= Number(b.custom_price || b.price) ? a : b));
    return {
      valor: Number(maisBarata.custom_price || maisBarata.price),
      prazoDias: maisBarata.custom_delivery_time || maisBarata.delivery_time,
      transportadora: maisBarata.company?.name || maisBarata.name,
      origem: 'melhorenvio'
    };
  } catch (err) {
    console.error('Falha ao consultar Melhor Envio, usando estimativa:', err.message);
    const valor = Math.max(18, peso * FALLBACK_POR_KG);
    return { valor: Number(valor.toFixed(2)), prazoDias: 7, origem: 'estimativa' };
  }
}

module.exports = { calcularFrete };
