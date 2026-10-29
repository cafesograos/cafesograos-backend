const zlib = require('zlib');
const crypto = require('crypto');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'alberto.adm@cafesograos.com';
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'Café Só Grãos <onboarding@resend.dev>';
const BACKUP_ENCRYPTION_KEY = process.env.BACKUP_ENCRYPTION_KEY;

// Tabelas com dado de negócio (pedidos, avaliações, cupons, leads). Fora
// melhorenvio_tokens de propósito: é credencial, não dado — se precisar,
// se reobtém reautorizando o OAuth, e não faz sentido mandar por e-mail.
const TABELAS_BACKUP = ['orders', 'reviews', 'discounts', 'leads'];

async function gerarBackupJson(pool) {
  const tabelas = {};
  for (const tabela of TABELAS_BACKUP) {
    const { rows } = await pool.query(`SELECT * FROM ${tabela}`);
    tabelas[tabela] = rows;
  }
  return { geradoEm: new Date().toISOString(), tabelas };
}

// Criptografa o gzip do backup (AES-256-GCM) antes de anexar no e-mail — o
// backup carrega CPF/passaporte, endereço e telefone de todo mundo que já
// comprou, então não pode ficar legível só por quem tiver acesso à caixa de
// entrada (phishing, encaminhamento por engano, conta do Resend comprometida).
// A chave nunca viaja no e-mail: fica só na variável BACKUP_ENCRYPTION_KEY do
// Railway. Formato do anexo: iv (12 bytes) + authTag (16 bytes) + cifrado.
// Pra abrir um backup antigo, use decrypt-backup.js.
function criptografarBackup(bufferGzip) {
  const chave = Buffer.from(BACKUP_ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(12);
  const cifra = crypto.createCipheriv('aes-256-gcm', chave, iv);
  const cifrado = Buffer.concat([cifra.update(bufferGzip), cifra.final()]);
  return Buffer.concat([iv, cifra.getAuthTag(), cifrado]);
}

async function enviarBackupPorEmail(pool) {
  if (!RESEND_API_KEY) {
    console.warn('AVISO: RESEND_API_KEY não definido. Backup diário não enviado.');
    return;
  }
  // Nunca manda o backup sem criptografar — prefere pular o backup do dia
  // (e avisar no log) a expor CPF/passaporte/endereço de todo mundo.
  if (!BACKUP_ENCRYPTION_KEY) {
    console.warn('AVISO: BACKUP_ENCRYPTION_KEY não definido. Backup diário não enviado (não manda dado pessoal sem criptografar).');
    return;
  }
  try {
    const backup = await gerarBackupJson(pool);
    const conteudoGzip = zlib.gzipSync(JSON.stringify(backup));
    const conteudoCifrado = criptografarBackup(conteudoGzip);
    const dataArquivo = backup.geradoEm.slice(0, 10);
    const totalLinhas = Object.values(backup.tabelas).reduce((soma, linhas) => soma + linhas.length, 0);

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [NOTIFY_EMAIL],
        subject: `Backup diário do banco — ${dataArquivo}`,
        html: `<p>Backup automático do banco de dados (${TABELAS_BACKUP.join(', ')}), ${totalLinhas} linhas no total.</p><p>Anexo criptografado (AES-256-GCM) — a chave está só na variável <code>BACKUP_ENCRYPTION_KEY</code> do Railway, nunca neste e-mail. Pra abrir, use <code>decrypt-backup.js</code> no repositório do backend.</p>`,
        attachments: [{
          filename: `backup-cafesograos-${dataArquivo}.json.gz.enc`,
          content: conteudoCifrado.toString('base64')
        }]
      })
    });

    if (!res.ok) {
      console.error('Erro ao enviar backup diário por e-mail:', res.status, await res.text());
      return;
    }
    console.log(`Backup diário enviado por e-mail, criptografado (${totalLinhas} linhas, ${dataArquivo}).`);
  } catch (err) {
    console.error('Erro ao gerar/enviar backup diário:', err.message);
  }
}

// Brasil não tem horário de verão desde 2019, então America/Sao_Paulo é
// sempre UTC-3 — 3h da manhã por lá é sempre 6h UTC, sem precisar de
// biblioteca de fuso horário só pra essa conta.
function agendarBackupDiario(pool) {
  const UM_DIA_MS = 24 * 60 * 60 * 1000;
  const HORA_UTC_DO_BACKUP = 6;

  function proximaExecucaoMs() {
    const agora = new Date();
    const proxima = new Date(Date.UTC(
      agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), HORA_UTC_DO_BACKUP, 0, 0
    ));
    if (proxima <= agora) proxima.setUTCDate(proxima.getUTCDate() + 1);
    return proxima.getTime() - agora.getTime();
  }

  setTimeout(function executarERepetir() {
    enviarBackupPorEmail(pool);
    setInterval(() => enviarBackupPorEmail(pool), UM_DIA_MS);
  }, proximaExecucaoMs());
}

module.exports = { agendarBackupDiario, enviarBackupPorEmail };
