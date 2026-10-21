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
  }
];

function montarCatalogoTexto(PRODUCTS) {
  return PRODUCTS.map((p) => `- id: ${p.id} | ${p.nome} | R$ ${p.preco.toFixed(2).replace('.', ',')}${p.precoOriginal ? ` (de R$ ${p.precoOriginal.toFixed(2).replace('.', ',')})` : ''} | ${p.descricao}`).join('\n');
}

function montarSystemPrompt(PRODUCTS) {
  return `Você é a atendente virtual da Café Só Grãos, uma torrefadora artesanal (café 100% arábica, torra semanal, direto do produtor, sediada em Araraquara/SP). Está conversando por WhatsApp com um cliente.

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

TOM: respostas curtas (é WhatsApp, não e-mail), simpática, direta, em português do Brasil. Sem emoji em excesso.

LIMITES: se o cliente perguntar algo fora disso (reclamação, troca, problema com pedido que você não consegue resolver com a ferramenta consultar_pedido), diga que alguém da equipe vai dar continuidade — não invente política nem prometa prazo que você não sabe.`;
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

async function responderMensagem(telefone, textoCliente, deps) {
  const { pool, PRODUCTS, criarPedidoViaAtendimento, consultarPedidoPorTelefone } = deps;
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
  if (textoResposta) await salvarMensagem(pool, telefone, 'assistant', textoResposta);
  return textoResposta;
}

module.exports = { responderMensagem };
