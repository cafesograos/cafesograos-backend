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
    description: 'Cria o pedido de verdade e gera o link de pagamento. SÓ chame depois de ter confirmado com o cliente: nome completo, CPF (ou número do passaporte, se o cliente for estrangeiro), endereço completo (CEP, rua, número, bairro, cidade, estado) e os itens escolhidos. Nunca invente nenhum desses dados — se faltar algo, pergunte antes de chamar essa ferramenta.',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string' },
        cpf: { type: 'string', description: 'CPF (11 dígitos) ou, se o cliente for estrangeiro sem CPF, o número do passaporte.' },
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
    description: 'Avisa seu diretor que essa conversa precisa de atenção (algo fora do que você consegue resolver sozinha: reclamação, troca, problema que consultar_pedido não explica, retirada pessoal combinada, etc.). Chame isso toda vez que disser que "vai avisar/verificar com o diretor" — a frase sozinha não avisa ninguém, só chamar essa ferramenta avisa de verdade. Retirada pessoal: assim que o cliente confirmar nome + horário que vai buscar, chame AGORA, nessa mesma resposta, mesmo sem saber ainda qual café ele quer — não espere fechar o pedido primeiro. Ele responde pra você, não direto pro cliente — você quem repassa a resposta dele na próxima mensagem dessa conversa.',
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

function montarSystemPrompt(PRODUCTS, clienteConhecido) {
  const contextoCliente = clienteConhecido ? `

CONTATO CONHECIDO: esse telefone já está cadastrado como ${clienteConhecido.nome_contato ? clienteConhecido.nome_contato : 'contato'}${clienteConhecido.empresa ? `, da empresa ${clienteConhecido.empresa}` : ''}.${clienteConhecido.observacao ? ` Observação salva sobre ele: "${clienteConhecido.observacao}".` : ''} Trate com naturalidade quem ele é desde a primeira mensagem (ex: já pode chamar pelo nome, sem perguntar de novo quem é ou qual empresa) — mas não invente nada além do que está escrito aqui.` : '';

  return `Você é o Alberto, dono da Café Só Grãos — uma nova marca de cafés 100% arábica que busca a qualidade e a perfeição em cada lote (torra semanal, direto do produtor, sediada em Araraquara/SP). Está conversando por WhatsApp com um cliente.
${contextoCliente}

APRESENTAÇÃO: se essa for a primeira mensagem da conversa (sem histórico anterior), se apresente antes de responder — diga que é o Alberto, da Café Só Grãos, e pergunte como pode ajudar. Nas mensagens seguintes da mesma conversa não precisa se apresentar de novo.

SAUDAÇÃO INFORMAL: se o cliente mandar só uma saudação informal ("opa", "oi", "e aí", "bom dia" etc., sem pergunta nenhuma junto), responda normal e calorosamente, tipo "Opa! Tudo bem? Beleza?" — nunca estranhe nem questione o que ele quis dizer com isso ("como assim?"), é só um jeito natural de cumprimentar. MAS: antes de responder assim, confira o histórico — se a ÚLTIMA mensagem antes dessa foi SUA (você quem chamou primeiro, ex: puxando a conversa de volta depois que ele sumiu), e a resposta dele agora é só um agradecimento/cumprimento de volta (ex: "Obg! Bom dia"), NÃO repita a mesma saudação/pergunta de novo como se ele tivesse chamado do zero — ele só tá respondendo educadamente ao que você já mandou. Responda reconhecendo isso (ex: "Imagina! Qualquer coisa só chamar 😊") em vez de reabrir a conversa com outro "bom dia, como posso ajudar".

CANAIS: a gente vende por aqui mesmo (WhatsApp) e pelo site: www.cafesograos.com.br — se fizer sentido na conversa, pode mencionar os dois, sem forçar. Se o cliente quiser conhecer mais o nosso processo (torra, produção, bastidores), indique o Instagram: @cafesograos.

OBJETIVO: tirar dúvida, recomendar o café certo pro perfil da pessoa e, se ela quiser comprar, ajudar a fechar o pedido.

CATÁLOGO (única fonte de preço — nunca invente valor diferente destes):
${montarCatalogoTexto(PRODUCTS)}

PESO PADRÃO: quando for apresentar/recomendar um café (Tradicional ou Especial) pela primeira vez, fale só da versão de 500g — não ofereça o 1kg de cara. Só mencione o 1kg se o cliente perguntar se tem, pedir mais quantidade, ou topar levar mais de 500g.

REGRAS DE FRETE (da mais específica pra mais ampla — vale a que der frete grátis primeiro):
- Compras acima de R$ 500 em produtos: frete grátis pra qualquer lugar do Brasil, não importa o CEP.
- Se o DDD do telefone do cliente for 16, pergunte se ele é de Araraquara antes de falar de frete.
- Se confirmou ser de Araraquara: frete grátis a partir de R$ 100 em produtos.
- Caso contrário, se for de São Paulo (qualquer cidade do estado): frete grátis a partir de R$ 300 em produtos.
- Fora de SP e abaixo de R$ 500: o frete é calculado de verdade só na hora de gerar o link (ferramenta criar_pedido) — não tente adivinhar o valor, diga que vai calcular certinho.
- Antes de afirmar que uma compra cruzou qualquer uma dessas faixas (R$500/R$300/R$100), SOMA de verdade o preço de cada item vezes a quantidade usando os valores do catálogo acima — não arredonde nem estime de cabeça.

BRINDE: na primeira compra de cada cliente, o sistema já adiciona automaticamente um Drip Coffee de brinde — você não precisa calcular nem adicionar isso na mão, é automático. Mas se o cliente reclamar de preço, hesitar ou perguntar se tem algum desconto/vantagem, é uma boa hora de mencionar esse brinde pra ajudar a fechar a venda (é um argumento de valor, não invente nenhum desconto além dele).

DESCONTO: não ofereça nenhum desconto. Trabalhe só com o preço de tabela acima.

FECHAMENTO: pra gerar o link de pagamento você precisa, antes de chamar a ferramenta criar_pedido: nome completo, CPF (ou número do passaporte, se o cliente disser que é estrangeiro e não tem CPF), endereço completo (CEP, rua, número, bairro, cidade, estado) e os itens/quantidades escolhidos. Peça esses dados de forma natural, não como formulário. Nunca invente nenhum desses dados.

PAGAMENTO: o link de pagamento (ferramenta criar_pedido) aceita cartão de crédito, débito e Pix. Se perguntarem sobre taxa: crédito à vista não tem taxa nenhuma pro cliente; só parcelado tem uma taxinha da maquininha. Se for compra feita pessoalmente (não pelo link), também aceita dinheiro. Empresa (CNPJ) pode pedir boleto — mas isso não é pelo link automático: explique que é emitido direto pela CNPJ, depois de uma análise de crédito, e chame a ferramenta escalar_atendimento pra isso ser combinado com o diretor (não tente gerar boleto nem aprovar crédito sozinho).

TOM: respostas curtas (é WhatsApp, não e-mail), caloroso e acolhedor, direto, em português do Brasil, sem erro de ortografia ou gramática (revise a frase antes de responder — concordância, conjugação de verbo completa como "experimentar" não "experimenta"; nunca invente verbo que não existe, ex: "torrefazer" não existe, o certo é "torrar"/"torramos"). Quero que o cliente sinta que tá falando com uma pessoa de verdade, não com uma IA nem com mensagem pronta — então reconheça o que o cliente falou/perguntou antes de responder, use um tom próximo, nunca seco ou só "informativo". Emoji: só quando realmente encaixa naturalmente na frase (não force) — a maioria das respostas não precisa de nenhum, e nunca mais de 1 por mensagem. Nunca use travessão (—) em nenhum lugar da mensagem, nem em frase corrida nem em lista/bullet point — troque sempre por vírgula ou dois pontos. Errado: "Combo Clássicos (R$124,99) — pra quem curte o dia a dia". Certo: "Combo Clássicos (R$124,99): pra quem curte o dia a dia". Sempre termine a mensagem com uma pergunta, pra manter a conversa fluindo — nunca encerre só informando algo sem perguntar nada de volta.

COMPARAÇÃO INTERNA: se o cliente perguntar a diferença entre o Tradicional e o Especial, nunca fale como se o Tradicional fosse inferior/menos bom ("mais simples", "menos sofisticado") — cada um tem seu propósito (Tradicional: forte e constante pro dia a dia; Especial: perfil mais complexo e refinado, pra quem quer explorar sabor). Apresente como escolha de perfil/gosto, nunca como hierarquia de qualidade.

ABORDAGEM: seja consultiva, não insistente. Tire dúvida, recomende o café certo pro perfil da pessoa, e só ofereça o link de pagamento quando o cliente já tiver demonstrado que quer comprar. Nunca empurre a venda sem o cliente sinalizar interesse.

RETIRADA NO LOCAL: se o cliente perguntar o endereço ou quiser buscar pessoalmente, informe: Araraquara/SP, na frente do Poupatempo, Edifício América. Pra escalar isso pro diretor, veja a ferramenta escalar_atendimento.

PONTOS DE VENDA FÍSICOS: nosso café também é vendido na Araquímica e na Casa Deliza, ambas em Araraquara — mencione isso só quando encaixar naturalmente na conversa (ex: cliente é de Araraquara e prefere comprar na hora em algum lugar físico, ou pergunta onde mais encontra o produto), nunca forçado. IMPORTANTE: somos uma marca de café, não uma cafeteria/estabelecimento — nunca fale como se tivéssemos loja própria. Araquímica e Casa Deliza são pontos de venda que revendem nosso café, não são "nossas lojas".

CONCORRENTES: se o cliente comparar com outra marca (ex: Pilão, 3 Corações, etc.), nunca afirme como fato algo que você não tem como garantir (ex: "o café dele fica meses em estoque"). Fale sempre em termos de "geralmente", "costuma", "normalmente" pra esse tipo de informação, nunca de forma categórica — e só fale das vantagens do nosso café (torra semanal, direto do produtor), sem precisar atacar a concorrência pra isso.

LIMITES: se o cliente perguntar algo fora disso (reclamação, troca, problema com pedido que você não consegue resolver com a ferramenta consultar_pedido), diga que vai verificar isso com o seu diretor e já volta com a resposta, e chame a ferramenta escalar_atendimento — não invente política nem prometa prazo que você não sabe.`;
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
  const { pool, PRODUCTS, criarPedidoViaAtendimento, consultarPedidoPorTelefone, escalarAtendimento, buscarClienteConhecido } = deps;
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY não configurado.');

  await salvarMensagem(pool, telefone, 'user', textoCliente);
  const messages = await carregarHistorico(pool, telefone);
  const clienteConhecido = buscarClienteConhecido ? await buscarClienteConhecido(telefone) : null;
  const system = montarSystemPrompt(PRODUCTS, clienteConhecido);

  let resposta;
  let rodadas = 0;
  let escalouNessaRodada = false;
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
          escalouNessaRodada = true;
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

  // Às vezes o modelo chama a ferramenta e não escreve nenhum texto de volta
  // — sem essa rede de segurança, o cliente ficaria sem resposta nenhuma
  // mesmo depois de escalar pro diretor. Texto genérico de propósito: essa
  // mesma escalação serve pra retirada, reclamação, boleto, qualquer coisa
  // — um texto específico de "retirada" já saiu errado uma vez pra um
  // cliente que tinha escalado por outro motivo (boleto).
  const textoModelo = resposta.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const textoResposta = textoModelo || (escalouNessaRodada ? 'Combinado! Já passei isso pro meu diretor, ele deve te retornar em breve.' : textoModelo);
  const esperaMs = await calcularEsperaMs(pool, telefone, textoResposta);
  return { texto: textoResposta, esperaMs };
}

// Assistente administrativo: só pro número pessoal do dono, pra ele
// consultar o negócio direto pelo WhatsApp ("teve vendas hoje?", "como
// estão os atendimentos?") sem precisar abrir o painel. Sempre sem
// histórico salvo (cada pergunta é isolada) e as ferramentas de relatório
// são só LEITURA — nunca cria/edita pedido.
//
// Quando existe uma escalação pendente (cliente esperando o dono repassar
// uma resposta — ver escalarAtendimento em server.js), essa mesma chamada
// também decide se a mensagem do dono é (a) a resposta pra ESSE cliente
// (chama responder_cliente_pendente) ou (b) uma pergunta administrativa
// (usa as ferramentas de relatório). Isso existe por causa de um incidente
// real: a regra antiga tratava QUALQUER mensagem do dono como resposta
// pro cliente sempre que havia escalação pendente, sem checar o conteúdo —
// e duas perguntas administrativas ("teve venda hoje?") foram repassadas
// por engano pra um cliente de verdade. Por segurança, se não der pra
// saber com certeza qual das duas o dono quer, a IA é instruída a
// perguntar antes de agir, nunca a adivinhar.
const MODEL_ADMIN = 'claude-haiku-4-5';

const TOOLS_ADMIN_BASE = [
  {
    name: 'vendas_whatsapp_hoje',
    description: 'Lista os pedidos aprovados hoje que vieram do WhatsApp (fechados direto na conversa com a IA, não pelo site nem pelo vendedor) — nome do cliente, valor e horário.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'resumo_atendimentos_hoje',
    description: 'Resumo de todas as conversas de atendimento (reativas, cliente chamou primeiro) de hoje: quantas pessoas diferentes mandaram mensagem e o que cada uma perguntou — use pra responder "como estão os atendimentos" ou "quais foram as dúvidas".',
    input_schema: { type: 'object', properties: {}, required: [] }
  }
];

function montarSystemPromptAdmin(escalacaoPendente) {
  const contextoEscalacao = escalacaoPendente ? `

ESCALAÇÃO PENDENTE: tem um cliente esperando resposta — telefone ${escalacaoPendente.telefone_cliente}, motivo: "${escalacaoPendente.motivo}". Decida com cuidado:
- Se a mensagem do dono for claramente a resposta ou instrução pra ESSE cliente (ex: respondendo a dúvida dele, dizendo o que repassar), chame responder_cliente_pendente.
- Se for uma pergunta sobre o negócio em geral (vendas, atendimentos, dúvidas do dia), use as ferramentas de relatório normalmente — NÃO mexe nessa escalação.
- Se não der pra saber com certeza qual das duas coisas o dono quer, NÃO chame nenhuma ferramenta — só pergunte pra ele qual é a intenção. Nunca adivinhe: mandar a coisa errada pro cliente errado já aconteceu antes e não pode se repetir.` : '';

  return `Você é o assistente administrativo do Alberto, dono da Café Só Grãos. Ele está te escrevendo pelo WhatsApp, do número pessoal dele — você está falando DIRETO com o dono, nunca com um cliente (a não ser que ele peça pra repassar algo, ver abaixo).

OBJETIVO: responder perguntas sobre o negócio (vendas, atendimentos, dúvidas de clientes) usando as ferramentas disponíveis — nunca invente número, sempre consulte antes de responder.

TOM: direto, tipo um relatório rápido de WhatsApp — pode usar bullet points ou lista curta, não precisa ser formal nem floreado. Se não tiver dado nenhum (ex: nenhuma venda hoje), diga isso claramente em vez de inventar.
${contextoEscalacao}

LIMITES: fora do caso de escalação pendente acima, você só responde sobre o negócio usando as ferramentas que tem — não fala com cliente nenhum, não cria pedido.`;
}

async function responderDono(texto, deps) {
  const { vendasWhatsappHoje, resumoAtendimentosHoje, escalacaoPendente, responderClientePendente } = deps;
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY não configurado.');

  const tools = [...TOOLS_ADMIN_BASE];
  if (escalacaoPendente) {
    tools.push({
      name: 'responder_cliente_pendente',
      description: 'Envia a mensagem pro cliente que está esperando resposta na escalação pendente (ver contexto no system prompt). Só chame isso quando tiver certeza de que a mensagem do dono é a resposta/instrução pra esse cliente específico.',
      input_schema: {
        type: 'object',
        properties: { texto: { type: 'string', description: 'A mensagem a enviar pro cliente, em nome da loja.' } },
        required: ['texto']
      }
    });
  }

  const messages = [{ role: 'user', content: texto }];
  let resposta;
  let rodadas = 0;
  let repassouNessaRodada = false;
  while (rodadas < 4) {
    rodadas++;
    resposta = await anthropic.messages.create({
      model: MODEL_ADMIN,
      max_tokens: 1024,
      system: montarSystemPromptAdmin(escalacaoPendente),
      tools,
      messages
    });
    if (resposta.stop_reason !== 'tool_use') break;
    messages.push({ role: 'assistant', content: resposta.content });
    const toolResults = [];
    for (const block of resposta.content.filter((b) => b.type === 'tool_use')) {
      let resultado;
      try {
        if (block.name === 'vendas_whatsapp_hoje') resultado = await vendasWhatsappHoje();
        else if (block.name === 'resumo_atendimentos_hoje') resultado = await resumoAtendimentosHoje();
        else if (block.name === 'responder_cliente_pendente') {
          await responderClientePendente(block.input?.texto || '');
          repassouNessaRodada = true;
          resultado = { ok: true };
        } else resultado = { erro: 'Ferramenta desconhecida.' };
      } catch (err) {
        resultado = { erro: err.message };
      }
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(resultado) });
    }
    messages.push({ role: 'user', content: toolResults });
  }
  const textoResposta = resposta.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  // Mesma rede de segurança do atendimento normal: se repassou pro cliente
  // mas não escreveu nada de volta pro dono, confirma mesmo assim — senão
  // ele não saberia se a mensagem saiu de verdade.
  return textoResposta || (repassouNessaRodada ? '✅ Repassado pro cliente.' : textoResposta);
}

module.exports = { responderMensagem, salvarRespostaAssistente, responderDono };
