const { pool } = require('./db');

const ORIGEM_CEP = '14800360';
const ME_BASE = 'https://melhorenvio.com.br';
const FALLBACK_POR_KG = 22; // usado só se a integração com o Melhor Envio estiver fora do ar

// Dados do remetente (Café Só Grãos) exigidos pela Melhor Envio pra inserir um
// frete real no carrinho — mesmo CEP de origem já usado na cotação. Endereço
// de onde o pacote sai fisicamente (não precisa ser o mesmo endereço fiscal
// do CNPJ, que é rural).
const REMETENTE = {
  name: 'Café Só Grãos',
  company_document: '68975236000187',
  state_register: 'ISENTO',
  economic_activity_code: '4637101',
  address: 'Rua Padre Duarte',
  number: '151',
  complement: 'Sala 123',
  district: 'Jardim Nova América',
  city: 'Araraquara',
  state_abbr: 'SP',
  country_id: 'BR',
  postal_code: ORIGEM_CEP,
  phone: '16997916459',
  email: 'alberto.adm@cafesograos.com'
};

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
      // Id do serviço cotado (ex.: 4 = Jadlog .Package) — sem isso, na hora de
      // comprar a etiqueta de verdade não dava pra saber qual das várias opções
      // (Correios, Jadlog, Total Express...) foi a que ficou mais barata pra
      // esse pedido específico.
      servicoId: maisBarata.id,
      origem: 'melhorenvio'
    };
  } catch (err) {
    console.error('Falha ao consultar Melhor Envio, usando estimativa:', err.message);
    const valor = Math.max(18, peso * FALLBACK_POR_KG);
    return { valor: Number(valor.toFixed(2)), prazoDias: 7, origem: 'estimativa' };
  }
}

// Insere o frete de um pedido no carrinho da Melhor Envio — primeiro passo
// pra comprar a etiqueta de verdade. Não cobra nada ainda (só "reserva" o
// serviço); o débito da carteira só acontece em comprarEtiquetas(). Devolve
// o objeto do item do carrinho (o "id" dele é o que as próximas chamadas
// usam pra pagar/gerar/imprimir/rastrear).
async function inserirNoCarrinho({ orderId, orderNsu, servicoId, pesoKg, destinatario, produtos, valorSeguro }) {
  const token = await getValidToken();
  const res = await fetch(`${ME_BASE}/api/v2/me/cart`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Cafe So Graos (alberto.adm@cafesograos.com)'
    },
    body: JSON.stringify({
      service: servicoId,
      from: REMETENTE,
      to: {
        name: destinatario.name,
        phone: destinatario.phone || '',
        email: destinatario.email || '',
        document: destinatario.document,
        address: destinatario.address,
        number: destinatario.number,
        complement: destinatario.complement || '',
        district: destinatario.district,
        city: destinatario.city,
        country_id: 'BR',
        postal_code: destinatario.postal_code,
        state_abbr: destinatario.state_abbr,
        note: ''
      },
      products: produtos,
      volumes: [{ height: 10, width: 15, length: 20, weight: pesoKg }],
      options: {
        insurance_value: valorSeguro,
        receipt: false,
        own_hand: false,
        reverse: false,
        non_commercial: true,
        platform: 'Café Só Grãos',
        tags: [{ tag: `Pedido #${orderId} — ${orderNsu}` }]
      }
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Melhor Envio recusou a inserção no carrinho: ' + JSON.stringify(data));
  return data;
}

// Debita da carteira Melhor Envio e efetiva a compra do(s) frete(s) já
// inseridos no carrinho. Depois disso o dinheiro saiu da carteira de verdade.
async function comprarEtiquetas(meOrderIds) {
  const token = await getValidToken();
  const res = await fetch(`${ME_BASE}/api/v2/me/shipment/checkout`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Cafe So Graos (alberto.adm@cafesograos.com)'
    },
    body: JSON.stringify({ orders: meOrderIds })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Melhor Envio recusou o pagamento: ' + JSON.stringify(data));
  return data;
}

// Gera a etiqueta de verdade (com código de rastreio) pros fretes já pagos.
async function gerarEtiquetas(meOrderIds) {
  const token = await getValidToken();
  const res = await fetch(`${ME_BASE}/api/v2/me/shipment/generate`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Cafe So Graos (alberto.adm@cafesograos.com)'
    },
    body: JSON.stringify({ orders: meOrderIds })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Melhor Envio recusou a geração da etiqueta: ' + JSON.stringify(data));
  return data;
}

// Devolve o link do PDF pra imprimir a(s) etiqueta(s) já gerada(s).
async function imprimirEtiquetas(meOrderIds) {
  const token = await getValidToken();
  const res = await fetch(`${ME_BASE}/api/v2/me/shipment/print`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Cafe So Graos (alberto.adm@cafesograos.com)'
    },
    body: JSON.stringify({ mode: 'private', orders: meOrderIds })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Melhor Envio recusou a impressão da etiqueta: ' + JSON.stringify(data));
  return data;
}

// Consulta o código de rastreio de um frete já gerado.
async function rastrearEtiquetas(meOrderIds) {
  const token = await getValidToken();
  const res = await fetch(`${ME_BASE}/api/v2/me/shipment/tracking`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Cafe So Graos (alberto.adm@cafesograos.com)'
    },
    body: JSON.stringify({ orders: meOrderIds })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Melhor Envio recusou a consulta de rastreio: ' + JSON.stringify(data));
  return data;
}

module.exports = {
  calcularFrete,
  inserirNoCarrinho,
  comprarEtiquetas,
  gerarEtiquetas,
  imprimirEtiquetas,
  rastrearEtiquetas
};
