// Automação de WhatsApp via Baileys (conexão não-oficial, tipo WhatsApp Web)
// — gratuita, mas depende de um número dedicado escaneando um QR code aqui
// (ver /admin/whatsapp) e corre risco de bloqueio pelo WhatsApp por não ser
// um canal oficial. Se bloquear, a migração natural é pra API oficial da Meta.
//
// A sessão (credenciais) fica salva no Postgres em vez de arquivo, porque o
// disco do Railway não persiste entre deploys — sem isso, cada deploy novo
// pediria pra escanear o QR de novo.

let waModule = null;
async function carregarBaileys() {
  if (!waModule) waModule = await import('@whiskeysockets/baileys');
  return waModule;
}

// Baileys espera um logger com essa interface (trace/debug/.../child). Um
// logger mudo evita depender do pino diretamente só por causa disso.
function loggerMudo() {
  const l = {
    trace() {}, debug() {}, info() {}, warn() {},
    error: (...args) => console.error('[whatsapp]', ...args),
    fatal: (...args) => console.error('[whatsapp]', ...args),
    level: 'silent'
  };
  l.child = () => l;
  return l;
}

async function usePostgresAuthState(pool) {
  const { initAuthCreds, proto, BufferJSON } = await carregarBaileys();

  async function lerDado(key) {
    const { rows } = await pool.query('SELECT value FROM whatsapp_auth WHERE key = $1', [key]);
    if (!rows[0]) return null;
    return JSON.parse(JSON.stringify(rows[0].value), BufferJSON.reviver);
  }
  async function salvarDado(key, value) {
    const data = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
    await pool.query(
      'INSERT INTO whatsapp_auth (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, data]
    );
  }
  async function apagarDado(key) {
    await pool.query('DELETE FROM whatsapp_auth WHERE key = $1', [key]);
  }

  const creds = (await lerDado('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await lerDado(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            if (value) data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tarefas = [];
          for (const categoria in data) {
            for (const id in data[categoria]) {
              const value = data[categoria][id];
              const key = `${categoria}-${id}`;
              tarefas.push(value ? salvarDado(key, value) : apagarDado(key));
            }
          }
          await Promise.all(tarefas);
        }
      }
    },
    saveCreds: () => salvarDado('creds', creds),
    limparSessao: async () => { await pool.query('DELETE FROM whatsapp_auth'); }
  };
}

let sock = null;
let authAtual = null;
let qrAtual = null;
let statusConexao = 'desconectado'; // desconectado | aguardando_qr | conectado
let handlerMensagem = null;
let tentativasSeguidas = 0;
let ultimoMotivoQueda = null;
// Depois de várias quedas seguidas sem nunca conectar, para de tentar sozinho
// em vez de martelar o servidor do WhatsApp pra sempre — fica parado até
// alguém mandar reconectar manualmente em /admin/whatsapp. Isso já aconteceu
// de verdade (ver histórico): o número ficou derrubando a conexão a cada 5s
// por um tempo longo sem nunca conseguir entrar, o que por si só já é um
// padrão de uso que pode levantar suspeita de automação pro WhatsApp.
const MAX_TENTATIVAS_SEGUIDAS = 8;

// Registra quem trata uma mensagem recebida de verdade (ver server.js, que
// liga isso na IA de atendimento) — mantém esse arquivo só como camada de
// transporte do WhatsApp, sem lógica de negócio aqui dentro.
function definirHandlerMensagem(callback) {
  handlerMensagem = callback;
}

async function iniciarWhatsApp(pool, { manual = false } = {}) {
  if (!pool) return;
  if (manual) tentativasSeguidas = 0;
  const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = await carregarBaileys();
  authAtual = await usePostgresAuthState(pool);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: authAtual.state,
    logger: loggerMudo(),
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', authAtual.saveCreds);

  // Não dá pra confiar só no "type" do evento pra saber se é mensagem nova:
  // "notify" normalmente é mensagem nova, mas mensagem nova chegando logo
  // depois de reconectar também pode vir marcada "append" (o Baileys ainda
  // tratando como sincronização) — já vimos isso derrubar mensagem de
  // cliente de verdade. Em vez disso, usa o horário da própria mensagem:
  // só processa quem chegou nos últimos 2 minutos, não importa o "type".
  const DOIS_MINUTOS_EM_SEGUNDOS = 120;
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    console.log(`[whatsapp] messages.upsert recebido — type: ${type}, qtd: ${messages?.length}, handler definido: ${!!handlerMensagem}`);
    if (!handlerMensagem) return;
    const agora = Math.floor(Date.now() / 1000);
    for (const msg of messages) {
      if (msg.key.fromMe || msg.key.remoteJid?.endsWith('@g.us')) {
        console.log('[whatsapp] mensagem ignorada (fromMe ou grupo).');
        continue;
      }
      const timestamp = Number(msg.messageTimestamp) || 0;
      if (agora - timestamp > DOIS_MINUTOS_EM_SEGUNDOS) {
        console.log(`[whatsapp] mensagem ignorada (antiga — ${agora - timestamp}s atrás).`);
        continue;
      }
      const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
      if (!texto) {
        console.log('[whatsapp] mensagem ignorada (sem texto reconhecido, tipo:', Object.keys(msg.message || {}), ').');
        continue;
      }
      const jidOriginal = msg.key.remoteJid;
      const telefone = jidOriginal?.split('@')[0];
      if (!telefone) continue;
      console.log(`[whatsapp] processando mensagem de ${telefone}: "${texto.slice(0, 60)}"`);
      Promise.resolve(handlerMensagem(telefone, texto, jidOriginal)).catch((err) => {
        console.error('[whatsapp] erro ao processar mensagem recebida:', err.message);
      });
    }
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrAtual = qr;
      statusConexao = 'aguardando_qr';
    }
    if (connection === 'open') {
      qrAtual = null;
      statusConexao = 'conectado';
      tentativasSeguidas = 0;
      console.log('WhatsApp conectado.');
    }
    if (connection === 'close') {
      statusConexao = 'desconectado';
      const motivo = lastDisconnect?.error?.output?.statusCode;
      const motivoTexto = lastDisconnect?.error?.message || motivo || 'desconhecido';
      ultimoMotivoQueda = motivoTexto;
      if (motivo === DisconnectReason.loggedOut) {
        tentativasSeguidas = 0;
        // Logout de verdade invalida a sessão salva — sem limpar, a próxima
        // reconexão (manual, em /admin/whatsapp) tenta de novo com as
        // credenciais já mortas e cai num erro de conexão em vez de gerar QR
        // novo. Limpando aqui, o próximo "Tentar conectar" já nasce do zero.
        if (authAtual) {
          authAtual.limparSessao().catch((err) => console.error('[whatsapp] falha ao limpar sessão após logout:', err.message));
        }
        console.log('WhatsApp desconectado (logout) — sessão limpa, escaneie o QR de novo em /admin/whatsapp.');
      } else {
        tentativasSeguidas++;
        if (tentativasSeguidas > MAX_TENTATIVAS_SEGUIDAS) {
          console.error(`[whatsapp] ${tentativasSeguidas} quedas seguidas (última: ${motivoTexto}) — parando de tentar sozinho. Reconecte manualmente em /admin/whatsapp.`);
          return;
        }
        console.log(`WhatsApp caiu (motivo: ${motivoTexto}), reconectando em 5s... (tentativa ${tentativasSeguidas}/${MAX_TENTATIVAS_SEGUIDAS})`);
        setTimeout(() => iniciarWhatsApp(pool), 5000);
      }
    }
  });
}

async function desconectarWhatsApp() {
  if (sock) {
    try { await sock.logout(); } catch (_) { /* já pode estar desconectado */ }
  }
  if (authAtual) await authAtual.limparSessao();
  sock = null;
  qrAtual = null;
  statusConexao = 'desconectado';
  tentativasSeguidas = 0;
}

async function enviarMensagemWhatsApp(telefoneOuJid, texto) {
  if (!sock || statusConexao !== 'conectado') {
    throw new Error('WhatsApp não conectado. Escaneie o QR em /admin/whatsapp.');
  }
  const valor = String(telefoneOuJid || '');
  // Alguns contatos (sem o número salvo na agenda de quem está falando com
  // eles) aparecem com JID "@lid" em vez de "@s.whatsapp.net" — reconstruir
  // sempre como @s.whatsapp.net manda a mensagem pra um número que não existe.
  // Se já vier um JID completo (com "@"), usa ele direto; senão, monta a
  // partir do número puro como antes.
  let jid;
  if (valor.includes('@')) {
    jid = valor;
  } else {
    const numero = valor.replace(/\D/g, '');
    if (!numero) throw new Error('Telefone inválido.');
    jid = `${numero}@s.whatsapp.net`;
  }
  await sock.sendMessage(jid, { text: texto });
}

module.exports = {
  iniciarWhatsApp,
  desconectarWhatsApp,
  enviarMensagemWhatsApp,
  definirHandlerMensagem,
  getStatusConexao: () => statusConexao,
  getQrAtual: () => qrAtual,
  getUltimoMotivoQueda: () => ultimoMotivoQueda
};
