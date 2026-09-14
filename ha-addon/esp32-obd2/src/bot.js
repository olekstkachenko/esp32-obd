const { Telegraf } = require('telegraf');
const config = require('./config');

let bot = null;

function initBot() {
  if (!config.TELEGRAM_BOT_TOKEN) {
    console.log("ℹ️ TELEGRAM_BOT_TOKEN not provided, skipping Telegraf bot initialization.");
    return null;
  }

  bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);

  bot.start((ctx) => {
    const webAppUrl = config.WEBAPP_URL || 'https://mankind-comprised-devotion.ngrok-free.dev';
    ctx.reply('🚗 Вітаю в OBD2 Дашборді! Натисніть кнопку нижче, щоб відкрити графіки:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📊 Відкрити OBD2 Графіки', web_app: { url: webAppUrl } }]
        ]
      }
    });
  });

  bot.command('status', (ctx) => {
    ctx.reply('✅ OBD2 Backend працює у штатному режимі.');
  });

  // Clear stuck webhooks before launching polling
  const https = require('https');
  const deleteWebhookUrl = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/deleteWebhook?drop_pending_updates=true`;
  https.get(deleteWebhookUrl, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      console.log('🤖 Telegram Webhook cleared. Starting bot polling...');
      bot.launch().catch(err => {
        console.error('❌ Failed to launch Telegraf bot:', err.message);
      });
    });
  }).on('error', (err) => {
    console.warn('⚠️ Could not clear Telegram webhook:', err.message);
    bot.launch().catch(() => {});
  });

  return bot;
}

function stopBot() {
  if (bot) {
    console.log('🤖 Stopping Telegraf bot...');
    bot.stop('SIGTERM');
  }
}

module.exports = {
  initBot,
  stopBot
};
