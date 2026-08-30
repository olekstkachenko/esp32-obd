const path = require('path');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/obd_data.db');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const WEBAPP_URL = process.env.WEBAPP_URL || '';

module.exports = {
  PORT,
  DB_PATH,
  TELEGRAM_BOT_TOKEN,
  WEBAPP_URL
};
