const ORIGEM_CEP = '14800360';
const SEDEX_FALLBACK_POR_KG = 22; // usado só se a API dos Correios estiver fora do ar

function limparCep(cep) {
  return String(cep || '').replace(/\D/g, '');
}

// Consulta o calculador público dos Correios (PAC). Sem contrato, sem autenticação.
async function calcularFrete(cepDestino, pesoKg) {
  const destino = limparCep(cepDestino);
  if (destino.length !== 8) {
    throw new Error('CEP inválido.');
  }

  const peso = Math.max(0.3, pesoKg || 0.3);
  const params = new URLSearchParams({
    nCdEmpresa: '',
    sDsSenha: '',
    nCdServico: '04510', // PAC
    sCepOrigem: ORIGEM_CEP,
    sCepDestino: destino,
    nVlPeso: peso.toFixed(2),
    nCdFormato: '1',
    nVlComprimento: '20',
    nVlAltura: '10',
    nVlLargura: '15',
    nVlDiametro: '0',
    sCdMaoPropria: 'n',
    nVlValorDeclarado: '0',
    sCdAvisoRecebimento: 'n',
    StrRetorno: 'xml'
  });

  const url = `http://ws.correios.com.br/calculador/CalcPrecoPrazo.aspx?${params.toString()}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    const xml = await res.text();

    const erro = (xml.match(/<Erro>(\d+)<\/Erro>/) || [])[1];
    const valorTexto = (xml.match(/<Valor>([\d,]+)<\/Valor>/) || [])[1];
    const prazo = (xml.match(/<PrazoEntrega>(\d+)<\/PrazoEntrega>/) || [])[1];

    if (erro && erro !== '0') throw new Error('Correios retornou erro: ' + erro);
    if (!valorTexto) throw new Error('Resposta inesperada dos Correios.');

    const valor = Number(valorTexto.replace('.', '').replace(',', '.'));
    return { valor, prazoDias: Number(prazo) || 7, origem: 'correios' };
  } catch (err) {
    console.error('Falha ao consultar Correios, usando estimativa:', err.message);
    // Fallback simples pra não travar o checkout se a API dos Correios estiver instável.
    const valor = Math.max(18, peso * SEDEX_FALLBACK_POR_KG);
    return { valor: Number(valor.toFixed(2)), prazoDias: 7, origem: 'estimativa' };
  }
}

module.exports = { calcularFrete };
