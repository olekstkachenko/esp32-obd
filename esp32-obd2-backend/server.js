require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { Telegraf } = require('telegraf');
const cors = require('cors');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Create data directory for SQLite if it doesn't exist (important for Docker volumes)
const fs = require('fs');
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
}

const db = new sqlite3.Database(path.join(dataDir, 'obd_data.db'), (err) => {
  if (err) console.error('Error opening db', err);
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS trips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    end_time DATETIME,
    distance_km REAL DEFAULT 0,
    avg_speed REAL DEFAULT 0,
    status TEXT DEFAULT 'active'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS obd_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    rpm REAL,
    speed REAL,
    temp REAL,
    voltage REAL,
    fuel_rate REAL
  )`);
});

let currentTripId = null;
let lastUpdateTimestamp = 0;
let lastRecordTime = 0;
const TRIP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

async function ensureActiveTrip() {
    return new Promise((resolve, reject) => {
        const now = Date.now();
        if (currentTripId && (now - lastUpdateTimestamp < TRIP_TIMEOUT_MS)) {
            lastUpdateTimestamp = now;
            resolve(currentTripId);
            return;
        }

        if (currentTripId) {
            db.run(`UPDATE trips SET status = 'completed', end_time = CURRENT_TIMESTAMP WHERE id = ?`, [currentTripId]);
        }

        db.run(`INSERT INTO trips (status) VALUES ('active')`, function(err) {
            if (err) reject(err);
            currentTripId = this.lastID;
            lastUpdateTimestamp = now;
            resolve(currentTripId);
        });
    });
}

async function updateTripStats(tripId, speedKmh, timeDiffSeconds) {
    if (timeDiffSeconds <= 0 || timeDiffSeconds > 60) return;
    const distanceKm = speedKmh * (timeDiffSeconds / 3600.0);
    db.run(`UPDATE trips SET 
            distance_km = distance_km + ?, 
            avg_speed = (SELECT AVG(speed) FROM obd_records WHERE trip_id = ? AND speed > 0)
            WHERE id = ?`, 
            [distanceKm, tripId, tripId]);
}

app.post('/api/obd', async (req, res) => {
  const { rpm, speed, temp, voltage, fuel_rate } = req.body;
  const now = Date.now();
  
  try {
      const tripId = await ensureActiveTrip();
      const timeDiffSeconds = lastRecordTime ? (now - lastRecordTime) / 1000.0 : 0;
      lastRecordTime = now;

      db.run(`INSERT INTO obd_records (trip_id, rpm, speed, temp, voltage, fuel_rate) VALUES (?, ?, ?, ?, ?, ?)`, 
          [tripId, rpm, speed, temp, voltage, fuel_rate], 
          async function(err) {
              if (err) return res.status(500).json({ error: err.message });
              if (speed > 0) await updateTripStats(tripId, speed, timeDiffSeconds);
              res.status(201).json({ success: true, tripId });
      });
  } catch(e) {
      res.status(500).json({ error: e.message });
  }
});

// Endpoint for the dashboard to get latest stats
app.get('/api/data', (req, res) => {
  db.get(`SELECT distance_km, avg_speed FROM trips WHERE id = ?`, [currentTripId], (err, tripRow) => {
      db.get(`SELECT rpm, speed, temp, voltage, fuel_rate FROM obd_records ORDER BY timestamp DESC LIMIT 1`, [], (err, latestRow) => {
          res.json({
              trip: tripRow || { distance_km: 0, avg_speed: 0 },
              latest: latestRow || { rpm: 0, speed: 0, temp: 0, voltage: 0, fuel_rate: 0 }
          });
      });
  });
});

// Endpoint for charts
app.get('/api/history', (req, res) => {
   db.all(`SELECT rpm, speed, timestamp FROM obd_records WHERE trip_id = ? ORDER BY timestamp DESC LIMIT 50`, [currentTripId], (err, rows) => {
       res.json((rows || []).reverse());
   });
});

console.log("--- STARTING TELEGRAM SETUP ---");
const botToken = process.env.TELEGRAM_BOT_TOKEN;
console.log("Token present in env:", botToken ? "YES" : "NO");

if (botToken) {
  try {
    console.log("Initializing Telegraf with forced IPv4...");
    // Force Node.js to use IPv4 only, which fixes the infinite hanging bug in Alpine
    const https = require('https');
    const agent = new https.Agent({ family: 4 });
    const bot = new Telegraf(botToken, { telegram: { agent } });
    
    const webAppUrl = process.env.WEBAPP_URL || `http://127.0.0.1:${port}`; 

    bot.start((ctx) => {
      ctx.reply('Привіт! Ваша телеметрія готова.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Відкрити OBD Графіки", web_app: { url: webAppUrl } }]
          ]
        }
      });
    });
    
    console.log("Calling bot.launch()...");
    bot.launch()
      .then(() => console.log("✅ Telegram Bot launched successfully!"))
      .catch((err) => console.error("❌ Telegram Bot failed to launch:", err));

    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
  } catch (err) {
    console.error("❌ Synchronous crash during Telegram setup:", err);
  }
} else {
  console.log("⚠️ TELEGRAM_BOT_TOKEN not provided.");
}
console.log("--- FINISHED TELEGRAM SETUP ---");

app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
});
