// Precisa ser o primeiro require de server.js — o Sentry só enxerga erros
// de módulos carregados depois dele.
require('dotenv').config();
const Sentry = require('@sentry/node');

Sentry.init({
  dsn: process.env.SENTRY_DSN
});
