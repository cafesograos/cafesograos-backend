const zlib = require('zlib');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'alberto.adm@cafesograos.com';
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'Café Só Grãos <onboarding@resend.dev>';

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

async function enviarBackupPorEmail(pool) {
  if (!RESEND_API_KEY) {
    console.warn('AVISO: RESEND_API_KEY não definido. Backup diário não enviado.');
    return;
  }
  try {
    const backup = await gerarBackupJson(pool);
    const conteudoGzip = zlib.gzipSync(JSON.stringify(backup));
    const dataArquivo = backup.geradoEm.slice(0, 10);
    const totalLinhas = Object.values(backup.tabelas).reduce((soma, linhas) => soma + linhas.length, 0);

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [NOTIFY_EMAIL],
        subject: `Backup diário do banco — ${dataArquivo}`,
        html: `<p>Backup automático do banco de dados (${TABELAS_BACKUP.join(', ')}), ${totalLinhas} linhas no total.</p><p>Guarde este e-mail — é a cópia de segurança caso o banco em produção seja perdido.</p>`,
        attachments: [{
          filename: `backup-cafesograos-${dataArquivo}.json.gz`,
          content: conteudoGzip.toString('base64')
        }]
      })
    });

    if (!res.ok) {
      console.error('Erro ao enviar backup diário por e-mail:', res.status, await res.text());
      return;
    }
    console.log(`Backup diário enviado por e-mail (${totalLinhas} linhas, ${dataArquivo}).`);
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
