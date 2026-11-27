// Integração oficial com a WhatsApp Business Platform (Cloud API) da Meta —
// substitui a conexão não-oficial via Baileys (tipo WhatsApp Web, removida
// depois da migração) porque esse tipo de conexão corria risco real de
// bloqueio pelo WhatsApp por não ser um canal autorizado. Diferente dela,
// aqui não existe "conexão" nem QR code pra escanear: é tudo chamada HTTP
// autenticada por token (WHATSAPP_TOKEN) contra a Graph API, e o número é
// identificado pelo ID da conta (WHATSAPP_WABA_ID).

const GRAPH_API_VERSION = 'v25.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

let handlerMensagem = null;
let phoneNumberIdCache = null;

// Registra quem trata uma mensagem recebida de verdade (ver server.js, que
// liga isso na IA de atendimento) — mantém esse arquivo só como camada de
// transporte do WhatsApp, sem lógica de negócio aqui dentro.
function definirHandlerMensagem(callback) {
  handlerMensagem = callback;
}

// Agrupa mensagens que chegam próximas umas das outras do mesmo número antes
// de chamar a IA — sem isso, quando o cliente manda em duas partes (ex: "bom
// dia" e, uns segundos depois, "vocês vendem pelo aplicativo?" completando o
// mesmo pensamento, ou só quebrando uma frase longa em várias bolhas), a IA
// respondia à primeira sem nunca ver a segunda, gerando duas respostas em
// vez de uma só. 6s não bastava — teste real mostrou 18s de intervalo entre
// duas bolhas da mesma pessoa; 20s dá margem confortável sem fazer o
// cliente esperar tempo absurdo pela primeira resposta.
const JANELA_AGRUPAMENTO_MS = 20000;
const buffersMensagem = new Map(); // telefone -> { textos, imagens, jid, timer }

// Serializa as rodadas do handler por telefone — sem isso, se a IA demorar
// mais que os 20s de janela pra responder a rodada A (ex: uma chamada de
// ferramenta mais lenta), e o cliente mandar mais mensagens nesse meio
// tempo, a rodada B dispara um SEGUNDO handlerMensagem(telefone, ...) pro
// mesmo número enquanto A ainda está rodando: as duas carregam o histórico,
// salvam a mensagem do cliente e salvam a resposta da IA ao mesmo tempo, o
// que pode quebrar a alternância estrita user/assistant que a API da
// Anthropic exige (ver carregarHistorico em whatsapp-ia.js) — e, uma vez
// quebrada, o histórico fica permanentemente inválido pra aquele telefone.
// Processo único (Node), então não precisa de lock de verdade: só encadear
// a execução por telefone garante a ordem.
const filaPorTelefone = new Map(); // telefone -> Promise da rodada em andamento

function executarEmFilaPorTelefone(telefone, tarefa) {
  const anterior = filaPorTelefone.get(telefone) || Promise.resolve();
  const atual = anterior.catch(() => {}).then(tarefa);
  filaPorTelefone.set(telefone, atual);
  // NÃO usar .finally() aqui: ele devolve uma promise DERIVADA que também
  // rejeita se "atual" rejeitar, e essa derivada não tem nenhum .catch() em
  // lugar nenhum — vira unhandled rejection e pode derrubar o processo. Com
  // .then(limpar, limpar) a limpeza roda nos dois casos (sucesso ou falha)
  // mas sem relançar nada, então a promise derivada nunca rejeita.
  const limpar = () => {
    if (filaPorTelefone.get(telefone) === atual) filaPorTelefone.delete(telefone);
  };
  atual.then(limpar, limpar);
  return atual;
}

// "imagens" é opcional: array de { base64, mediaType }, pra quando a
// mensagem é uma foto (com ou sem legenda — ver processarImagemRecebida).
// Sem isso, uma foto SEM legenda nenhuma (texto vazio) nunca entrava na
// fila, porque a checagem original (!texto) descartava mensagem sem texto
// — mas uma foto sozinha é uma mensagem válida mesmo sem nenhuma legenda.
//
// Limite de 4 imagens por rodada de agrupamento: cada uma pode chegar a 5MB
// (TAMANHO_MAX_IMAGEM_BYTES), e a API da Anthropic tem limite de tamanho
// total de request — sem esse teto, um cliente mandando várias fotos
// seguidas (ex.: registrando um produto com defeito pra troca/devolução,
// exatamente o caso que a regra FOTOS do prompt incentiva) podia estourar
// esse limite e derrubar a chamada inteira, deixando o cliente sem resposta
// nenhuma em vez de só não ver as fotos excedentes.
const MAX_IMAGENS_POR_RODADA = 4;
// Reserva a vaga de forma SÍNCRONA, antes de qualquer await — essencial
// porque, se a Meta mandar várias fotos no mesmo payload de webhook (ela
// agrupa mensagens quase simultâneas num só POST), processarWebhookRecebido
// chama processarImagemRecebida várias vezes em sequência SEM esperar o
// download de cada uma terminar. Checar "quantas imagens já tem no buffer"
// só depois do download (como uma versão anterior fazia) deixava passar as
// 5+ chamadas, porque nenhum download tinha terminado ainda pra atualizar a
// contagem — todas viam "0 imagens ainda" e baixavam em paralelo à toa.
// Reservando antes (incrementando um contador que nunca é lido por await
// nenhum no meio), a 5ª chamada já vê a reserva das 4 anteriores e nem
// começa o download.
function reservarVagaImagem(telefone, jidOriginal) {
  let buffer = buffersMensagem.get(telefone);
  if (!buffer) {
    buffer = { textos: [], imagens: [], imagensReservadas: 0, jid: jidOriginal };
    buffersMensagem.set(telefone, buffer);
  }
  buffer.jid = jidOriginal || buffer.jid;
  if (buffer.imagensReservadas >= MAX_IMAGENS_POR_RODADA) return false;
  buffer.imagensReservadas++;
  return true;
}
function enfileirarMensagemRecebida(telefone, texto, jidOriginal, imagemReservada) {
  if (!handlerMensagem) return;
  if (!texto && !imagemReservada) return;
  let buffer = buffersMensagem.get(telefone);
  if (!buffer) {
    buffer = { textos: [], imagens: [], imagensReservadas: 0, jid: jidOriginal };
    buffersMensagem.set(telefone, buffer);
  }
  if (texto) buffer.textos.push(texto);
  // A vaga já foi reservada antes do download (ver reservarVagaImagem) —
  // aqui é só confirmar a imagem de verdade no lugar já contado, nunca
  // checar limite de novo.
  if (imagemReservada) buffer.imagens.push(imagemReservada);
  buffer.jid = jidOriginal || buffer.jid;
  clearTimeout(buffer.timer);
  buffer.timer = setTimeout(() => {
    buffersMensagem.delete(telefone);
    const textoCombinado = buffer.textos.join('\n');
    executarEmFilaPorTelefone(telefone, () => handlerMensagem(telefone, textoCombinado, buffer.jid, buffer.imagens)).catch((err) => {
      console.error('[whatsapp-oficial] erro ao processar mensagem recebida:', err.message);
    });
  }, JANELA_AGRUPAMENTO_MS);
}

// O phone_number_id não muda depois que o número é registrado na conta, então
// busca uma vez só e guarda em memória — evita uma chamada extra à Graph API
// a cada mensagem enviada. Descoberto em runtime (em vez de fixo numa env
// var) pra não precisar copiar mais um ID sensível na hora de configurar.
async function obterPhoneNumberId() {
  if (phoneNumberIdCache) return phoneNumberIdCache;
  const wabaId = process.env.WHATSAPP_WABA_ID;
  const token = process.env.WHATSAPP_TOKEN;
  if (!wabaId || !token) {
    throw new Error('WhatsApp não configurado (WHATSAPP_WABA_ID ou WHATSAPP_TOKEN ausente).');
  }
  const res = await fetch(`${GRAPH_API_BASE}/${wabaId}/phone_numbers`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'Falha ao buscar o número de telefone na Meta.');
  const numero = data.data?.[0];
  if (!numero) throw new Error('Nenhum número de telefone encontrado nessa conta do WhatsApp.');
  phoneNumberIdCache = numero.id;
  return phoneNumberIdCache;
}

async function enviarMensagemWhatsApp(telefoneOuJid, texto) {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) throw new Error('WhatsApp não configurado (WHATSAPP_TOKEN ausente).');
  // Aceita tanto número puro quanto o formato de JID que o Baileys usava
  // ("5511999999999@s.whatsapp.net") — extrai só os dígitos, porque quem já
  // chamava essa função (ex.: escalarAtendimento em server.js) continua
  // passando valores nesses dois formatos.
  const numero = String(telefoneOuJid || '').replace(/\D/g, '');
  if (!numero) throw new Error('Telefone inválido.');
  const phoneNumberId = await obterPhoneNumberId();
  const res = await fetch(`${GRAPH_API_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: numero, type: 'text', text: { body: texto } })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'Falha ao enviar mensagem pelo WhatsApp.');
  return data;
}

// Mensagem de imagem por link (a Meta busca a URL pública e envia ela
// mesma, sem precisar fazer upload de mídia antes) -- mesmo padrão de
// enviarMensagemWhatsApp acima, só troca o "type" e o corpo da mensagem.
// Quem chama decide o link (ver enviar_imagem_promocional, que só aceita
// um enum fixo de 2 imagens -- nunca passar aqui uma URL vinda direto do
// modelo da IA).
async function enviarImagemWhatsApp(telefoneOuJid, link, legenda) {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) throw new Error('WhatsApp não configurado (WHATSAPP_TOKEN ausente).');
  const numero = String(telefoneOuJid || '').replace(/\D/g, '');
  if (!numero) throw new Error('Telefone inválido.');
  const phoneNumberId = await obterPhoneNumberId();
  const res = await fetch(`${GRAPH_API_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: numero, type: 'image', image: { link, caption: legenda || undefined } })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'Falha ao enviar imagem pelo WhatsApp.');
  return data;
}

// Mensagem de template aprovado — obrigatório pra qualquer mensagem que A
// LOJA inicia (cliente não mandou nada antes, tipo boas-vindas ou lembrete
// de recompra), porque a Meta só libera texto livre dentro da janela de 24h
// depois de o cliente ter mandado mensagem primeiro. `nomeTemplate` precisa
// bater exatamente com o nome aprovado no WhatsApp Manager; `parametros` é
// um objeto { nome_da_variavel: valor } com os valores pra preencher as
// variáveis nomeadas do corpo do template (ex: {{nome_cliente}}) — a Meta
// passou a exigir variável nomeada em vez de numerada ({{1}}, {{2}}). O
// texto em si do template não muda aqui, só os valores — mudar a redação
// exige reaprovação no Meta.
async function enviarTemplateWhatsApp(telefoneOuJid, nomeTemplate, parametros = {}) {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) throw new Error('WhatsApp não configurado (WHATSAPP_TOKEN ausente).');
  const numero = String(telefoneOuJid || '').replace(/\D/g, '');
  if (!numero) throw new Error('Telefone inválido.');
  const phoneNumberId = await obterPhoneNumberId();
  const nomesVariaveis = Object.keys(parametros);
  const res = await fetch(`${GRAPH_API_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: numero,
      type: 'template',
      template: {
        name: nomeTemplate,
        language: { code: 'pt_BR' },
        ...(nomesVariaveis.length ? {
          components: [{
            type: 'body',
            parameters: nomesVariaveis.map((nome) => ({ type: 'text', parameter_name: nome, text: String(parametros[nome]) }))
          }]
        } : {})
      }
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'Falha ao enviar template pelo WhatsApp.');
  return data;
}

// Baixa um arquivo de mídia que a Meta só manda como ID — precisa de duas
// chamadas: a primeira pra pegar a URL real de download (temporária, exige
// o token de novo), a segunda pra baixar o arquivo em si (também exige o
// token, senão a Meta recusa).
async function baixarMidiaWhatsApp(mediaId) {
  const token = process.env.WHATSAPP_TOKEN;
  const resInfo = await fetch(`${GRAPH_API_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const info = await resInfo.json();
  if (!resInfo.ok || !info.url) throw new Error(info?.error?.message || 'Falha ao obter URL da mídia.');
  const resArquivo = await fetch(info.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resArquivo.ok) throw new Error('Falha ao baixar arquivo de mídia da Meta.');
  const buffer = Buffer.from(await resArquivo.arrayBuffer());
  return { buffer, mimeType: info.mime_type };
}

// A IA de atendimento (Anthropic) só lê texto — pra entender áudio de voz
// do cliente, transcreve antes via Whisper (OpenAI) e trata o resultado
// como se o cliente tivesse digitado.
async function transcreverAudio(buffer, mimeType) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY não configurada — não dá pra transcrever áudio.');
  const extensao = mimeType?.includes('ogg') ? 'ogg' : mimeType?.includes('mp4') ? 'mp4' : 'mp3';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'audio/ogg' }), `audio.${extensao}`);
  form.append('model', 'whisper-1');
  form.append('language', 'pt');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'Falha ao transcrever áudio.');
  return (data.text || '').trim();
}

// Baixa + transcreve + repassa pro mesmo handler do texto — assim pro resto
// do sistema (IA, histórico salvo) um áudio é indistinguível de uma
// mensagem digitada.
async function processarAudioRecebido(telefone, mediaId) {
  try {
    const { buffer, mimeType } = await baixarMidiaWhatsApp(mediaId);
    const texto = await transcreverAudio(buffer, mimeType);
    if (!texto) {
      console.log(`[whatsapp-oficial] áudio de ${telefone} transcrito vazio — ignorado.`);
      return;
    }
    console.log(`[whatsapp-oficial] áudio de ${telefone} transcrito: "${texto}"`);
    enfileirarMensagemRecebida(telefone, texto, telefone);
  } catch (err) {
    console.error(`[whatsapp-oficial] falha ao processar áudio de ${telefone}:`, err.message);
  }
}

// A API da Anthropic só aceita esses 4 formatos de imagem, como valor EXATO
// de "media_type" (não aceita parâmetro extra tipo "; charset=..."). A Meta
// às vezes devolve o mime type com esse tipo de parâmetro a mais (mesmo
// motivo pelo qual transcreverAudio, um pouco acima, usa .includes('ogg')
// em vez de igualdade estrita) — por isso essa função não só CONFERE o
// tipo, como devolve a forma NORMALIZADA (só "image/jpeg", sem o resto),
// que é o valor de verdade mandado pra API lá em whatsapp-ia.js. Nunca usar
// o mimeType bruto da Meta direto no campo media_type da Anthropic.
const TIPOS_IMAGEM_SUPORTADOS = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
function normalizarTipoImagem(mimeType) {
  const tipoMinusculo = mimeType?.toLowerCase();
  return TIPOS_IMAGEM_SUPORTADOS.find((tipo) => tipoMinusculo?.startsWith(tipo)) || null;
}
// Mesmo limite documentado pela Anthropic pra imagem em base64 — mas o
// limite é sobre o tamanho JÁ CODIFICADO em base64, que fica exatamente
// 4/3 maior que o arquivo bruto (3 bytes brutos viram 4 caracteres base64).
// Checar o buffer bruto direto contra 5MB deixaria passar arquivo que vira
// maior que 5MB depois de codificado — por isso o limite aqui já é abaixo
// do real, calculado de trás pra frente a partir do tamanho que o base64
// vai dar.
const TAMANHO_MAX_IMAGEM_BYTES = Math.floor((5 * 1024 * 1024) / (4 / 3));

// Baixa a foto e repassa pro mesmo handler do texto, como um bloco de
// imagem (base64) — a IA (Claude) interpreta imagem nativamente, sem
// precisar de nenhum serviço de transcrição como no áudio. "legenda" é o
// texto que o cliente escreveu junto da foto (pode não ter nenhuma).
// Quando a imagem falha (download, tipo não suportado, tamanho), sempre
// inclui uma nota factual avisando que uma foto foi tentada e não abriu —
// tanto quando não há legenda nenhuma (senão a IA nunca saberia que uma
// mensagem chegou, e o cliente ficaria sem resposta) quanto quando há
// legenda (senão a IA responderia só o texto, sem noção nenhuma de que uma
// foto também foi enviada e falhou). A nota é só uma frase factual, sem
// instrução imperativa pro modelo — a regra FOTOS no prompt já ensina como
// reagir, e isso também evita que o painel admin (que mostra esse texto
// como se fosse o cliente escrevendo) fique com instrução de sistema
// aparecendo como fala do cliente.
function enfileirarAposFalhaDeImagem(telefone, legenda, motivo) {
  const nota = `[o cliente tentou enviar uma foto, mas não foi possível abrir: ${motivo}]`;
  const texto = legenda ? `${legenda}\n${nota}` : nota;
  enfileirarMensagemRecebida(telefone, texto, telefone);
}

async function processarImagemRecebida(telefone, mediaId, legenda) {
  // Reserva a vaga de forma SÍNCRONA, antes de qualquer await (ver
  // reservarVagaImagem) — garante que, mesmo que a Meta mande várias fotos
  // no mesmo payload de webhook (processadas em sequência sem esperar o
  // download de cada uma), a 5ª chamada já vê as 4 reservas anteriores e
  // nem começa a baixar.
  if (!reservarVagaImagem(telefone, telefone)) {
    console.warn(`[whatsapp-oficial] imagem de ${telefone} ignorada sem baixar — limite de ${MAX_IMAGENS_POR_RODADA} por rodada já atingido.`);
    enfileirarAposFalhaDeImagem(telefone, legenda, 'limite de fotos por mensagem atingido');
    return;
  }
  // Imagem inválida ou com falha de download não pode derrubar a legenda
  // junto — se o cliente escreveu uma pergunta real junto da foto (ex.:
  // "isso veio errado, dá pra trocar?"), ela ainda precisa chegar na IA
  // mesmo sem a imagem, senão o cliente manda uma mensagem de verdade e não
  // recebe resposta nenhuma. Por isso o try/catch envolve só o download —
  // qualquer caminho de saída (sucesso, validação falhou, exceção) sempre
  // passa por enfileirarAposFalhaDeImagem antes de retornar (a vaga já
  // reservada simplesmente fica sem uso nesses casos, não é devolvida —
  // tentar devolver depois de um await reabriria a mesma corrida que essa
  // reserva existe pra evitar).
  let buffer, mimeType;
  try {
    ({ buffer, mimeType } = await baixarMidiaWhatsApp(mediaId));
  } catch (err) {
    console.error(`[whatsapp-oficial] falha ao baixar imagem de ${telefone}:`, err.message, '— imagem ignorada.');
    enfileirarAposFalhaDeImagem(telefone, legenda, 'falha ao baixar do WhatsApp');
    return;
  }
  const tipoNormalizado = normalizarTipoImagem(mimeType);
  if (!tipoNormalizado) {
    console.warn(`[whatsapp-oficial] imagem de ${telefone} com tipo não suportado (${mimeType}) — imagem ignorada.`);
    enfileirarAposFalhaDeImagem(telefone, legenda, 'formato de imagem não suportado');
    return;
  }
  if (buffer.length > TAMANHO_MAX_IMAGEM_BYTES) {
    console.warn(`[whatsapp-oficial] imagem de ${telefone} grande demais (${buffer.length} bytes) — imagem ignorada.`);
    enfileirarAposFalhaDeImagem(telefone, legenda, 'arquivo grande demais');
    return;
  }
  console.log(`[whatsapp-oficial] imagem de ${telefone} recebida (${mimeType}, ${buffer.length} bytes)${legenda ? ` com legenda: "${legenda}"` : ' sem legenda'}.`);
  enfileirarMensagemRecebida(telefone, legenda || '', telefone, { base64: buffer.toString('base64'), mediaType: tipoNormalizado });
}

// A Meta garante entrega "pelo menos uma vez" — o mesmo evento pode chegar
// duplicado nesse webhook (reenvio por timeout, retry de rede etc.). Sem
// filtrar pelo id da mensagem, uma reentrega faria a IA responder de novo
// pra algo que o cliente já recebeu resposta. Cache em memória (não precisa
// sobreviver a restart: reentrega da Meta acontece em minutos, não em dias).
const mensagensProcessadas = new Map(); // msg.id -> timestamp
const JANELA_DEDUP_MS = 10 * 60 * 1000;

function jaProcessada(msgId) {
  const agora = Date.now();
  for (const [id, ts] of mensagensProcessadas) {
    if (agora - ts > JANELA_DEDUP_MS) mensagensProcessadas.delete(id);
  }
  if (mensagensProcessadas.has(msgId)) return true;
  mensagensProcessadas.set(msgId, agora);
  return false;
}

// Chamado pelo POST /webhook-whatsapp (ver server.js) a cada evento que a
// Meta entrega pro número configurado. Processa mensagem de texto, áudio e
// imagem recebida de cliente (ignora reação, documento etc. por enquanto)
// e também loga status de entrega (sent/delivered/read/failed) —
// sem isso a gente nunca saberia se um envio que a API aceitou ("accepted")
// de fato chegou no celular do cliente ou falhou silenciosamente depois.
function processarWebhookRecebido(body) {
  const entradas = body?.entry || [];
  for (const entrada of entradas) {
    for (const mudanca of entrada.changes || []) {
      const valor = mudanca.value;

      for (const status of valor?.statuses || []) {
        if (status.status === 'failed') {
          const erro = status.errors?.[0];
          console.error(`[whatsapp-oficial] ENTREGA FALHOU pra ${status.recipient_id}: (#${erro?.code}) ${erro?.title || erro?.message || 'sem detalhe'}`);
        } else {
          console.log(`[whatsapp-oficial] status "${status.status}" pra ${status.recipient_id} (msg ${status.id}).`);
        }
      }

      for (const msg of valor?.messages || []) {
        const telefone = msg.from;
        if (!telefone) continue;
        if (msg.id && jaProcessada(msg.id)) {
          console.log(`[whatsapp-oficial] mensagem ${msg.id} já processada (reentrega da Meta) — ignorada.`);
          continue;
        }
        if (msg.type === 'text' && msg.text?.body) {
          if (!handlerMensagem) continue;
          enfileirarMensagemRecebida(telefone, msg.text.body, telefone);
        } else if (msg.type === 'audio' && msg.audio?.id) {
          processarAudioRecebido(telefone, msg.audio.id).catch((err) => {
            console.error('[whatsapp-oficial] erro ao processar áudio recebido:', err.message);
          });
        } else if (msg.type === 'image' && msg.image?.id) {
          processarImagemRecebida(telefone, msg.image.id, msg.image.caption).catch((err) => {
            console.error('[whatsapp-oficial] erro ao processar imagem recebida:', err.message);
          });
        }
      }
    }
  }
}

function getStatusConexao() {
  return (process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_WABA_ID) ? 'conectado' : 'desconectado';
}

module.exports = {
  enviarMensagemWhatsApp,
  enviarImagemWhatsApp,
  enviarTemplateWhatsApp,
  definirHandlerMensagem,
  processarWebhookRecebido,
  getStatusConexao,
  // Exportado pra server.js também serializar escritas que tocam o
  // histórico de um cliente por fora da rodada normal da IA (ver o repasse
  // da resposta do dono numa escalação, em responderClientePendente) — sem
  // isso, essa escrita roda sob a fila do número do DONO, não a do cliente
  // de verdade, e pode intercalar com uma rodada da IA pra esse mesmo
  // cliente em andamento ao mesmo tempo.
  executarEmFilaPorTelefone,
  // Compatibilidade com a interface antiga (da conexão via Baileys, já
  // removida) — a API oficial não tem QR code nem "conectar"/"desconectar"
  // de verdade, é tudo configuração por variável de ambiente, então essas
  // funções viram no-op.
  iniciarWhatsApp: async () => {},
  desconectarWhatsApp: async () => {},
  getQrAtual: () => null,
  getUltimoMotivoQueda: () => null
};
