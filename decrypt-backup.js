// Descriptografa um anexo de backup diário (.json.gz.enc, ver backup.js) de
// volta pro JSON original. A chave nunca fica neste arquivo nem no e-mail —
// só na variável BACKUP_ENCRYPTION_KEY do Railway (railway variables --kv).
//
// Uso:
//   BACKUP_ENCRYPTION_KEY=<chave> node decrypt-backup.js backup-cafesograos-2026-10-29.json.gz.enc
//
// Gera backup-cafesograos-2026-10-29.json ao lado do arquivo original.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const arquivo = process.argv[2];
const chaveHex = process.env.BACKUP_ENCRYPTION_KEY;

if (!arquivo || !chaveHex) {
  console.error('Uso: BACKUP_ENCRYPTION_KEY=<chave> node decrypt-backup.js <arquivo.json.gz.enc>');
  process.exit(1);
}

const dados = fs.readFileSync(arquivo);
const iv = dados.subarray(0, 12);
const authTag = dados.subarray(12, 28);
const cifrado = dados.subarray(28);

const decifra = crypto.createDecipheriv('aes-256-gcm', Buffer.from(chaveHex, 'hex'), iv);
decifra.setAuthTag(authTag);
const bufferGzip = Buffer.concat([decifra.update(cifrado), decifra.final()]);
const json = zlib.gunzipSync(bufferGzip).toString('utf8');

const saida = path.basename(arquivo).replace(/\.enc$/, '').replace(/\.gz$/, '');
fs.writeFileSync(saida, json);
console.log(`Backup descriptografado: ${saida}`);
