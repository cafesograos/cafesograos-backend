// IA de atendimento reativa no WhatsApp — só responde quando o cliente manda
// mensagem primeiro (nunca inicia conversa sozinha, pra não repetir o
// incidente de spam que já tivemos). Usa o catálogo real do servidor pra
// nunca inventar preço, e só fecha pedido de verdade via criarPedidoViaAtendimento
// (mesma validação de preço/peso do resto do site).
//
// Modelo: Haiku 4.5 — rápido e barato o suficiente pra conversa de atendimento,
// decisão tomada com o dono depois de ver o preço real (console.anthropic.com).
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const MODEL = 'claude-haiku-4-5';
const HISTORICO_MAX_MENSAGENS = 30;

const TOOLS = [
  {
    name: 'consultar_pedido',
    description: 'Busca o pedido mais recente desse cliente (pelo telefone da conversa) pra saber status, código de rastreio etc. Use quando o cliente perguntar sobre um pedido já feito.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'criar_pedido',
    description: 'Cria o pedido de verdade e gera o link de pagamento. SÓ chame depois de ter confirmado com o cliente: nome completo, CPF, endereço completo (CEP, rua, número, bairro, cidade, estado) e os itens escolhidos. Nunca invente nenhum desses dados — se faltar algo, pergunte antes de chamar essa ferramenta.',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string' },
        cpf: { type: 'string', description: 'Somente números ou formatado, 11 dígitos.' },
        cep: { type: 'string' },
        endereco: { type: 'string', description: 'Nome da rua/avenida.' },
        numero: { type: 'string' },
        complemento: { type: 'string' },
        bairro: { type: 'string' },
        cidade: { type: 'string' },
        estado: { type: 'string', description: 'Sigla de 2 letras, ex: SP.' },
        itens: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              produtoId: { type: 'string', description: 'id do produto no catálogo' },
              quantity: { type: 'integer' }
            },
            required: ['produtoId', 'quantity']
          }
        },
        araraquaraConfirmado: { type: 'boolean', description: 'true SOMENTE se o cliente confirmou explicitamente que mora em Araraquara (pergunte isso quando o DDD do telefone for 16).' }
      },
      required: ['nome', 'cpf', 'cep', 'endereco', 'numero', 'bairro', 'cidade', 'estado', 'itens']
    }
  },
  {
    name: 'escalar_atendimento',
    description: 'Avisa um humano da equipe que essa conversa precisa de atenção (algo fora do que você consegue resolver sozinha: reclamação, troca, problema que consultar_pedido não explica, etc.). Chame isso toda vez que disser que "alguém da equipe vai dar continuidade".',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Resumo curto do que o cliente precisa, pro humano entender rápido ao abrir a conversa.' }
      },
      required: ['motivo']
    }
  }
];

function montarCatalogoTexto(PRODUCTS) {
  return PRODUCTS.map((p) => `- id: ${p.id} | ${p.nome} | R$ ${p.preco.toFixed(2).replace('.', ',')}${p.precoOriginal ? ` (de R$ ${p.precoOriginal.toFixed(2).replace('.', ',')})` : ''} | ${p.descricao}`).join('\n');
}

function montarSystemPrompt(PRODUCTS) {
  return `Você é o Alberto, dono da Café Só Grãos, uma torrefadora artesanal (café 100% arábica, torra semanal, direto do produtor, sediada em Araraquara/SP). Está conversando por WhatsApp com um cliente.

APRESENTAÇÃO: se essa for a primeira mensagem da conversa (sem histórico anterior), se apresente antes de responder — diga que é o Alberto, da Café Só Grãos, e pergunte como pode ajudar. Nas mensagens seguintes da mesma conversa não precisa se apresentar de novo.

OBJETIVO: tirar dúvida, recomendar o café certo pro perfil da pessoa e, se ela quiser comprar, ajudar a fechar o pedido.

CATÁLOGO (única fonte de preço — nunca invente valor diferente destes):
${montarCatalogoTexto(PRODUCTS)}

REGRAS DE FRETE:
- Se o DDD do telefone do cliente for 16, pergunte se ele é de Araraquara antes de falar de frete.
- Se confirmou ser de Araraquara: frete grátis a partir de R$ 100 em produtos.
- Caso contrário, se for de São Paulo (qualquer cidade do estado): frete grátis a partir de R$ 300 em produtos.
- Fora de SP ou abaixo do mínimo: o frete é calculado de verdade só na hora de gerar o link (ferramenta criar_pedido) — não tente adivinhar o valor, diga que vai calcular certinho.

BRINDE: na primeira compra de cada cliente, o sistema já adiciona automaticamente um Drip Coffee de brinde — você não precisa oferecer isso nem calcular, é automático.

DESCONTO: não ofereça nenhum desconto. Trabalhe só com o preço de tabela acima.

FECHAMENTO: pra gerar o link de pagamento você precisa, antes de chamar a ferramenta criar_pedido: nome completo, CPF, endereço completo (CEP, rua, número, bairro, cidade, estado) e os itens/quantidades escolhidos. Peça esses dados de forma natural, não como formulário. Nunca invente nenhum desses dados.

TOM: respostas curtas (é WhatsApp, não e-mail), simpático, direto, em português do Brasil. Sempre use alguns emojis (sem exagerar). Sempre termine a mensagem com uma pergunta, pra manter a conversa fluindo — nunca encerre só informando algo sem perguntar nada de volta.

ABORDAGEM: seja consultiva, não insistente. Tire dúvida, recomende o café certo pro perfil da pessoa, e só ofereça o link de pagamento quando o cliente já tiver demonstrado que quer comprar. Nunca empurre a venda sem o cliente sinalizar interesse.

LIMITES: se o cliente perguntar algo fora disso (reclamação, troca, problema com pedido que você não consegue resolver com a ferramenta consultar_pedido), diga que alguém da equipe vai dar continuidade e chame a ferramenta escalar_atendimento — não invente política nem prometa prazo que você não sabe.`;
}

async function carregarHistorico(pool, telefone) {
  const { rows } = await pool.query(
    `SELECT role, content FROM whatsapp_mensagens WHERE phone = $1 ORDER BY created_at DESC LIMIT $2`,
    [telefone, HISTORICO_MAX_MENSAGENS]
  );
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

async function salvarMensagem(pool, telefone, role, content) {
  await pool.query(
    'INSERT INTO whatsapp_mensagens (phone, role, content) VALUES ($1, $2, $3)',
    [telefone, role, content]
  );
}

const ESPERA_MIN_MS = 2000;
const ESPERA_MAX_MS = 60000;

// Espelha o ritmo do cliente: quanto mais rápido ele responde, mais rápido
// a gente responde (até um mínimo que dá tempo de "digitar" a mensagem sem
// parecer robô), e quanto mais ele demora, mais a gente demora — até um
// teto de 1 min, pra conversa não ficar travada esperando tempo real.
// Usa o horário em que a resposta ANTERIOR foi de fato enviada (não gerada)
// como referência, porque é isso que o cliente realmente viu.
async function calcularEsperaMs(pool, telefone, textoResposta) {
  const minPeloTamanho = Math.max(ESPERA_MIN_MS, Math.ceil((textoResposta || '').length / 20) * 1000);
  const { rows } = await pool.query(
    `SELECT created_at FROM whatsapp_mensagens WHERE phone = $1 AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`,
    [telefone]
  );
  const ultimaRespostaEm = rows[0]?.created_at;
  if (!ultimaRespostaEm) {
    // Primeira troca da conversa — sem referência de ritmo ainda.
    return Math.min(ESPERA_MAX_MS, Math.max(minPeloTamanho, 5000 + Math.floor(Math.random() * 10000)));
  }
  const tempoQueClienteLevou = Date.now() - new Date(ultimaRespostaEm).getTime();
  const folga = 1000 + Math.floor(Math.random() * 2000); // um pouquinho mais devagar que a pessoa, de propósito
  return Math.min(ESPERA_MAX_MS, Math.max(minPeloTamanho, tempoQueClienteLevou + folga));
}

async function salvarRespostaAssistente(pool, telefone, texto) {
  if (texto) await salvarMensagem(pool, telefone, 'assistant', texto);
}

async function responderMensagem(telefone, textoCliente, deps) {
  const { pool, PRODUCTS, criarPedidoViaAtendimento, consultarPedidoPorTelefone, escalarAtendimento } = deps;
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY não configurado.');

  await salvarMensagem(pool, telefone, 'user', textoCliente);
  const messages = await carregarHistorico(pool, telefone);
  const system = montarSystemPrompt(PRODUCTS);

  let resposta;
  let rodadas = 0;
  while (rodadas < 5) {
    rodadas++;
    resposta = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      tools: TOOLS,
      messages
    });

    if (resposta.stop_reason !== 'tool_use') break;

    messages.push({ role: 'assistant', content: resposta.content });

    const toolUseBlocks = resposta.content.filter((b) => b.type === 'tool_use');
    const toolResults = [];
    for (const block of toolUseBlocks) {
      let resultado;
      try {
        if (block.name === 'consultar_pedido') {
          resultado = await consultarPedidoPorTelefone(telefone);
        } else if (block.name === 'criar_pedido') {
          resultado = await criarPedidoViaAtendimento({ ...block.input, telefone });
        } else if (block.name === 'escalar_atendimento') {
          await escalarAtendimento(telefone, block.input?.motivo || '');
          resultado = { ok: true };
        } else {
          resultado = { erro: 'Ferramenta desconhecida.' };
        }
      } catch (err) {
        resultado = { erro: err.message };
      }
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(resultado) });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  const textoResposta = resposta.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const esperaMs = await calcularEsperaMs(pool, telefone, textoResposta);
  return { texto: textoResposta, esperaMs };
}

module.exports = { responderMensagem, salvarRespostaAssistente };
