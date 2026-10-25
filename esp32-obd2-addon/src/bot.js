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

  bot.command('service', async (ctx) => {
    try {
      const db = require('./db');
      const baseSetting = await db.getAsync("SELECT value FROM settings WHERE key = 'odometer_base'");
      const baseOdo = baseSetting ? (parseFloat(baseSetting.value) || 0) : 215000;
      const tripsSum = await db.getAsync("SELECT SUM(distance_km) as total_dist FROM trips");
      const totalTripsDist = (tripsSum && tripsSum.total_dist) ? parseFloat(tripsSum.total_dist) : 0;
      const curOdo = Math.round((baseOdo + totalTripsDist) * 10) / 10;

      const items = await db.allAsync("SELECT * FROM service_items ORDER BY id ASC");
      let msg = `🛠️ *Сервісна книжка Pajero 4*\n🚗 Поточний одометр: *${curOdo.toLocaleString('uk-UA')} км*\n\n`;

      for (const it of (items || [])) {
        const lastOdo = it.last_service_odometer || 0;
        const kmSince = Math.max(0, Math.round(curOdo - lastOdo));
        const kmRem = it.interval_km - kmSince;
        let icon = '🟢';
        if (kmRem <= 0) icon = '🔴';
        else if (kmRem <= it.interval_km * 0.2) icon = '🟡';

        msg += `${icon} *${it.title}*\n`;
        msg += `   ├ Залишок: *${kmRem > 0 ? kmRem.toLocaleString('uk-UA') + ' км' : 'ПРОСТРОЧЕНО (' + Math.abs(kmRem) + ' км)'}*\n`;
        msg += `   └ Інтервал: ${it.interval_km.toLocaleString('uk-UA')} км (остання заміна: ${lastOdo.toLocaleString('uk-UA')} км)\n\n`;
      }

      ctx.replyWithMarkdown(msg);
    } catch(err) {
      ctx.reply('❌ Помилка отримання даних сервісу: ' + err.message);
    }
  });

  bot.command('report', async (ctx) => {
    try {
      const db = require('./db');
      const stats = await db.getAsync(`
        SELECT COUNT(*) as count,
               COALESCE(SUM(distance_km), 0) as dist,
               COALESCE(SUM(fuel_liters), 0) as fuel,
               COALESCE(AVG(NULLIF(avg_speed, 0)), 0) as speed
        FROM trips
        WHERE DATE(start_time) >= DATE('now', '-30 days')
      `);

      const fuelSetting = await db.getAsync("SELECT value FROM settings WHERE key = 'fuel_price'");
      const price = fuelSetting ? (parseFloat(fuelSetting.value) || 58.50) : 58.50;

      const dist = Math.round((stats.dist || 0) * 10) / 10;
      const fuel = Math.round((stats.fuel || 0) * 10) / 10;
      const cost = Math.round(fuel * price);
      const l100 = dist > 0 ? ((fuel / dist) * 100).toFixed(1) : '0.0';
      const costPerKm = dist > 0 ? (cost / dist).toFixed(2) : '0.00';

      let msg = `📊 *Звіт про поїздки Pajero 4 (за 30 днів)*\n\n`;
      msg += `🛣️ Загальний пробіг: *${dist.toLocaleString('uk-UA')} км*\n`;
      msg += `⛽ Витрачено пального: *${fuel} л* (в середньому *${l100} л/100км*)\n`;
      msg += `💰 Витрати на пальне: *${cost.toLocaleString('uk-UA')} грн* (~${costPerKm} грн/км)\n`;
      msg += `⚡ Сер. швидкість: *${Math.round(stats.speed || 0)} км/год*\n`;
      msg += `🔢 Кількість поїздок: *${stats.count || 0}*`;

      ctx.replyWithMarkdown(msg);
    } catch(err) {
      ctx.reply('❌ Помилка формування звіту: ' + err.message);
    }
  });

  bot.command('today', async (ctx) => {
    try {
      const db = require('./db');
      const stats = await db.getAsync(`
        SELECT COUNT(*) as count,
               COALESCE(SUM(distance_km), 0) as dist,
               COALESCE(SUM(duration_seconds), 0) as duration,
               COALESCE(SUM(fuel_liters), 0) as fuel,
               COALESCE(AVG(NULLIF(avg_speed, 0)), 0) as speed,
               COALESCE(MAX(max_speed), 0) as max_speed
        FROM trips
        WHERE DATE(start_time, 'localtime') = DATE('now', 'localtime')
      `);

      const fuelSetting = await db.getAsync("SELECT value FROM settings WHERE key = 'fuel_price'");
      const price = fuelSetting ? (parseFloat(fuelSetting.value) || 58.50) : 58.50;

      const count = stats ? (stats.count || 0) : 0;
      const dist = Math.round((stats.dist || 0) * 10) / 10;
      const durationSec = stats ? (stats.duration || 0) : 0;
      const fuel = Math.round((stats.fuel || 0) * 10) / 10;
      const cost = Math.round(fuel * price);
      const l100 = dist > 0 ? ((fuel / dist) * 100).toFixed(1) : '0.0';

      const durM = Math.floor(durationSec / 60);
      const durH = Math.floor(durM / 60);
      const durationText = durH > 0 ? `${durH} год ${durM % 60} хв` : `${durM} хв`;

      const todayStr = new Date().toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' });

      let msg = `📅 *Підсумок за сьогодні (${todayStr})*\n\n`;
      if (count === 0) {
        msg += `🚗 Сьогодні збережених поїздок ще не було.`;
      } else {
        msg += `🔢 Кількість поїздок: *${count}*\n`;
        msg += `🛣️ Загальний пробіг: *${dist.toLocaleString('uk-UA')} км*\n`;
        msg += `⏱️ Час у дорозі: *${durationText}*\n`;
        msg += `⛽ Витрата пального: *${fuel} л* (~*${l100} л/100км*)\n`;
        msg += `💰 Витрати за день: *${cost.toLocaleString('uk-UA')} грн*\n`;
        msg += `⚡ Сер. швидкість: *${Math.round(stats.speed || 0)} км/год* (макс: *${Math.round(stats.max_speed || 0)} км/год*)`;
      }

      ctx.replyWithMarkdown(msg);
    } catch(err) {
      ctx.reply('❌ Помилка формування підсумку за день: ' + err.message);
    }
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
