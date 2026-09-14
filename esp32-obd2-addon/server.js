const express = require('express');
const path = require('path');
const config = require('./src/config');
const db = require('./src/db');
const bot = require('./src/bot');
const fuelScraper = require('./src/services/fuelScraper');
const apiRoutes = require('./src/routes/api');

const app = express();

// Middlewares
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ngrok warning bypass middleware
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

// API Routes
app.use('/api', apiRoutes);

// Health check endpoint for Docker & Monitoring
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start Background Services
fuelScraper.startBackgroundFuelScraper();
bot.initBot();

// Start Server
const server = app.listen(config.PORT, () => {
  console.log(`🚀 ESP32 OBD2 Server running at http://localhost:${config.PORT}`);
});

// Graceful Shutdown Handler
function gracefulShutdown(signal) {
  console.log(`\n⚠️ Received ${signal}. Starting graceful shutdown...`);

  bot.stopBot();

  server.close(() => {
    console.log('🌐 HTTP Server closed.');
    
    db.close((err) => {
      if (err) {
        console.error('❌ Error closing SQLite DB:', err.message);
      } else {
        console.log('💾 SQLite DB connection closed.');
      }
      process.exit(0);
    });
  });

  // Force exit after 5 seconds if graceful shutdown hangs
  setTimeout(() => {
    console.error('⚠️ Forcing process exit after 5s timeout.');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
