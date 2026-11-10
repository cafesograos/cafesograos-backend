// Integração oficial com a WhatsApp Business Platform (Cloud API) da Meta —
// substitui o Baileys (whatsapp.js, mantido só como histórico) porque a
// conexão não-oficial (tipo WhatsApp Web) corria risco real de bloqueio pelo
// WhatsApp por não ser um canal autorizado. Diferente do Baileys, aqui não
// existe "conexão" nem QR code pra escanear: é tudo chamada HTTP autenticada
// por token (WHATSAPP_TOKEN) contra a Graph API, e o número é identificado
// pelo ID da conta (WHATSAPP_WABA_ID).

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

// Chamado pelo POST /webhook-whatsapp (ver server.js) a cada evento que a
// Meta entrega pro número configurado. Processa mensagem de texto recebida
// de cliente (ignora reação, mensagem de mídia etc., mesmo filtro que o
// Baileys já aplicava) e também loga status de entrega (sent/delivered/
// read/failed) — sem isso a gente nunca saberia se um envio que a API
// aceitou ("accepted") de fato chegou no celular do cliente ou falhou
// silenciosamente depois.
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

      if (!handlerMensagem) continue;
      for (const msg of valor?.messages || []) {
        if (msg.type !== 'text') continue;
        const telefone = msg.from;
        const texto = msg.text?.body;
        if (!telefone || !texto) continue;
        Promise.resolve(handlerMensagem(telefone, texto, telefone)).catch((err) => {
          console.error('[whatsapp-oficial] erro ao processar mensagem recebida:', err.message);
        });
      }
    }
  }
}

function getStatusConexao() {
  return (process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_WABA_ID) ? 'conectado' : 'desconectado';
}

module.exports = {
  enviarMensagemWhatsApp,
  enviarTemplateWhatsApp,
  definirHandlerMensagem,
  processarWebhookRecebido,
  getStatusConexao,
  // Compatibilidade com a interface antiga (ver whatsapp.js) — a API oficial
  // não tem QR code nem "conectar"/"desconectar" de verdade, é tudo
  // configuração por variável de ambiente, então essas funções viram no-op.
  iniciarWhatsApp: async () => {},
  desconectarWhatsApp: async () => {},
  getQrAtual: () => null,
  getUltimoMotivoQueda: () => null
};
