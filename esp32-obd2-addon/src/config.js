const path = require('path');
const fs = require('fs');

// Auto-detect and parse Home Assistant Add-on options if running inside HA
let haOptions = {};
const haOptionsPath = '/data/options.json';
if (fs.existsSync(haOptionsPath)) {
  try {
    haOptions = JSON.parse(fs.readFileSync(haOptionsPath, 'utf8'));
    console.log('🏠 Loaded configuration from Home Assistant /data/options.json');
  } catch (e) {
    console.error('⚠️ Failed to parse /data/options.json:', e.message);
  }
}

const PORT = haOptions.port || process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || (fs.existsSync('/data') ? '/data/obd_data.db' : path.join(__dirname, '../data/obd_data.db'));
const TELEGRAM_BOT_TOKEN = haOptions.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN || '';
const WEBAPP_URL = haOptions.webapp_url || process.env.WEBAPP_URL || '';

module.exports = {
  PORT,
  DB_PATH,
  TELEGRAM_BOT_TOKEN,
  WEBAPP_URL,
  haOptions
};

