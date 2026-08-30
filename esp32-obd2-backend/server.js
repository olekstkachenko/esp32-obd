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
    max_speed REAL DEFAULT 0,
    fuel_liters REAL DEFAULT 0,
    status TEXT DEFAULT 'active'
  )`);

  // Migrate existing DB if columns don't exist
  db.run(`ALTER TABLE trips ADD COLUMN max_speed REAL DEFAULT 0`, () => {});
  db.run(`ALTER TABLE trips ADD COLUMN fuel_liters REAL DEFAULT 0`, () => {});

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

  db.run(`CREATE TABLE IF NOT EXISTS fuel_prices (
    station TEXT PRIMARY KEY,
    price REAL,
    fuel_type TEXT DEFAULT 'A-95',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('fuel_price', '82.90')`);

  // Seed initial fuel prices if table is empty
  const defaultPrices = [
    ['OKKO', 82.90],
    ['WOG', 82.90],
    ['UPG', 78.90],
    ['KLO', 79.90],
    ['UKRNAFTA', 78.90]
  ];
  defaultPrices.forEach(([st, pr]) => {
    db.run(`INSERT OR IGNORE INTO fuel_prices (station, price, fuel_type) VALUES (?, ?, 'A-95')`, [st, pr]);
  });

  // Recover active or latest trip on startup
  db.get(`SELECT id, status FROM trips ORDER BY id DESC LIMIT 1`, [], (err, row) => {
    if (row && row.status === 'active') {
      currentTripId = row.id;
      lastUpdateTimestamp = Date.now();
    }
  });
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

        db.run(`INSERT INTO trips (status, max_speed, fuel_liters) VALUES ('active', 0, 0)`, function(err) {
            if (err) return reject(err);
            currentTripId = this.lastID;
            lastUpdateTimestamp = now;
            resolve(currentTripId);
        });
    });
}

async function updateTripStats(tripId, speedKmh, fuelRateLh, timeDiffSeconds) {
    if (timeDiffSeconds <= 0 || timeDiffSeconds > 60) return;
    const distanceKm = (speedKmh > 0) ? (speedKmh * (timeDiffSeconds / 3600.0)) : 0;
    
    // Calculate fuel used: from fuel_rate (L/h) or estimated fallback from distance
    let addedFuel = 0;
    if (fuelRateLh && fuelRateLh > 0) {
      addedFuel = fuelRateLh * (timeDiffSeconds / 3600.0);
    } else if (distanceKm > 0) {
      // Fallback estimate 7.5L/100km if no MAF sensor
      addedFuel = (distanceKm * 7.5) / 100.0;
    }

    db.run(`UPDATE trips SET 
            distance_km = distance_km + ?, 
            fuel_liters = fuel_liters + ?,
            avg_speed = (SELECT AVG(speed) FROM obd_records WHERE trip_id = ? AND speed > 0),
            max_speed = MAX(COALESCE(max_speed, 0), ?)
            WHERE id = ?`, 
            [distanceKm, addedFuel, tripId, speedKmh, tripId]);
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
              await updateTripStats(tripId, speed || 0, fuel_rate || 0, timeDiffSeconds);
              res.status(201).json({ success: true, tripId });
      });
  } catch(e) {
      res.status(500).json({ error: e.message });
  }
});

// Endpoint for the dashboard to get latest stats
app.get('/api/data', (req, res) => {
  const activeId = currentTripId;
  const tripQuery = activeId 
    ? `SELECT * FROM trips WHERE id = ?` 
    : `SELECT * FROM trips ORDER BY id DESC LIMIT 1`;
  const tripParams = activeId ? [activeId] : [];

  db.get(tripQuery, tripParams, (err, tripRow) => {
      db.get(`SELECT rpm, speed, temp, voltage, fuel_rate FROM obd_records ORDER BY timestamp DESC LIMIT 1`, [], (err, latestRow) => {
          res.json({
              trip: tripRow || { distance_km: 0, avg_speed: 0, max_speed: 0, status: 'none' },
              latest: latestRow || { rpm: 0, speed: 0, temp: 0, voltage: 0, fuel_rate: 0 }
          });
      });
  });
});

// Endpoint for live charts
app.get('/api/history', (req, res) => {
   const targetTripId = currentTripId;
   const query = targetTripId 
     ? `SELECT rpm, speed, timestamp FROM obd_records WHERE trip_id = ? ORDER BY timestamp DESC LIMIT 60`
     : `SELECT rpm, speed, timestamp FROM obd_records ORDER BY timestamp DESC LIMIT 60`;
   const params = targetTripId ? [targetTripId] : [];

   db.all(query, params, (err, rows) => {
       res.json((rows || []).reverse());
   });
});

// --- Trips Archive Endpoints ---

// 1. Get list of all trips with statistics and fuel cost
app.get('/api/trips', (req, res) => {
  const sql = `
    SELECT 
      t.id,
      t.start_time,
      t.end_time,
      ROUND(t.distance_km, 2) AS distance_km,
      ROUND(COALESCE(t.avg_speed, 0), 1) AS avg_speed,
      ROUND(COALESCE(t.max_speed, (SELECT MAX(speed) FROM obd_records WHERE trip_id = t.id), 0), 1) AS max_speed,
      ROUND(COALESCE(t.fuel_liters, 0), 2) AS fuel_liters,
      ROUND(COALESCE((SELECT AVG(fuel_rate) FROM obd_records WHERE trip_id = t.id AND fuel_rate > 0), 0), 1) AS avg_fuel_rate,
      CASE 
        WHEN t.distance_km > 0.05 AND t.fuel_liters > 0 THEN ROUND((t.fuel_liters / t.distance_km) * 100, 1)
        ELSE 0 
      END AS l_per_100km,
      ROUND(COALESCE(t.fuel_liters, 0) * (SELECT CAST(COALESCE(value, '82.90') AS REAL) FROM settings WHERE key = 'fuel_price'), 2) AS trip_cost_uah,
      COUNT(o.id) AS records_count,
      ROUND((JULIANDAY(COALESCE(t.end_time, 'now')) - JULIANDAY(t.start_time)) * 86400) AS duration_seconds,
      t.status
    FROM trips t
    LEFT JOIN obd_records o ON t.id = o.trip_id
    GROUP BY t.id
    ORDER BY t.id DESC
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// 2. Get specific trip details and its complete telemetry points
app.get('/api/trips/:id', (req, res) => {
  const tripId = req.params.id;
  db.get(`SELECT *, 
          ROUND(COALESCE(fuel_liters, 0), 2) AS fuel_liters,
          ROUND(COALESCE(fuel_liters, 0) * (SELECT CAST(COALESCE(value, '82.90') AS REAL) FROM settings WHERE key = 'fuel_price'), 2) AS trip_cost_uah
          FROM trips WHERE id = ?`, [tripId], (err, trip) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!trip) return res.status(404).json({ error: 'Поїздку не знайдено' });

    db.all(`SELECT rpm, speed, temp, voltage, fuel_rate, timestamp FROM obd_records WHERE trip_id = ? ORDER BY timestamp ASC`, [tripId], (err, records) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ trip, records: records || [] });
    });
  });
});

// 3. Delete a trip and its records
app.delete('/api/trips/:id', (req, res) => {
  const tripId = req.params.id;
  db.run(`DELETE FROM obd_records WHERE trip_id = ?`, [tripId], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.run(`DELETE FROM trips WHERE id = ?`, [tripId], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      if (currentTripId == tripId) currentTripId = null;
      res.json({ success: true });
    });
  });
});

// 4. Manually finish the current active trip
app.post('/api/trips/finish', (req, res) => {
  if (currentTripId) {
    db.run(`UPDATE trips SET status = 'completed', end_time = CURRENT_TIMESTAMP WHERE id = ?`, [currentTripId], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      const finishedId = currentTripId;
      currentTripId = null;
      res.json({ success: true, finishedTripId: finishedId });
    });
  } else {
    res.json({ success: true, message: 'Немає активної поїздки' });
  }
});

// --- Fuel Prices Scraper & Settings ---

const https = require('https');

// 1. Direct WOG API fetcher
function fetchWogDirect() {
  return new Promise((resolve) => {
    https.get('https://api.wog.ua/fuel_stations', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          const filters = json.data?.fuel_filters || [];
          // Look for regular 95 (not Mustang)
          const f95 = filters.find(f => (f.name === '95' || f.name === 'А-95') && !String(f.brand).includes('Mustang'))
                   || filters.find(f => f.name === '95');
          if (f95 && f95.price) {
            const price = f95.price / 100.0;
            console.log(`[WOG Direct API] Found A-95 price: ${price} грн`);
            return resolve(price);
          }
        } catch (e) {}
        resolve(null);
      });
    }).on('error', () => resolve(null));
  });
}

// 2. Direct UPG web page parser
function fetchUpgDirect() {
  return new Promise((resolve) => {
    https.get('https://upg.ua/cini-na-palne/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html'
      },
      timeout: 8000
    }, (res) => {
      let html = '';
      res.on('data', c => { html += c; });
      res.on('end', () => {
        try {
          const match = /var\s+obj\s*=\s*({[\s\S]*?});/.exec(html);
          if (match) {
            const json = JSON.parse(match[1]);
            const items = json.data || [];
            // Find A-95 entries
            const a95List = items.filter(it => it.Title === 'A-95' || it.FuelTypeId === 2);
            if (a95List.length > 0) {
              const sum = a95List.reduce((acc, curr) => acc + parseFloat(curr.AveragePrice || 0), 0);
              const avg = Math.round((sum / a95List.length) * 100) / 100;
              console.log(`[UPG Direct] Found A-95 price: ${avg} грн`);
              return resolve(avg);
            }
          }
        } catch (e) {}
        resolve(null);
      });
    }).on('error', () => resolve(null));
  });
}

// 3. Minfin aggregator (for OKKO, KLO, UKRNAFTA and fallback)
function fetchMinfinPrices() {
  return new Promise((resolve) => {
    const url = 'https://index.minfin.com.ua/ua/markets/fuel/tm/';
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html'
      },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const targetStations = {
            'окко': 'OKKO',
            'okko': 'OKKO',
            'wog': 'WOG',
            'upg': 'UPG',
            'klo': 'KLO',
            'ukrnafta': 'UKRNAFTA',
            'укрнафта': 'UKRNAFTA'
          };
          const parsed = {};
          const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
          let match;
          while ((match = rowRegex.exec(data)) !== null) {
            const rowHtml = match[1];
            const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
            const cells = [];
            let tdMatch;
            while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
              cells.push(tdMatch[1].replace(/<[^>]+>/g, '').trim());
            }
            if (cells.length >= 4) {
              const stationNameRaw = cells[0].toLowerCase();
              for (const [key, normalized] of Object.entries(targetStations)) {
                if (stationNameRaw === key || stationNameRaw.includes(key)) {
                  const priceStr = cells[3].replace(',', '.').trim();
                  const price = parseFloat(priceStr);
                  if (!isNaN(price) && price > 30 && price < 150) {
                    parsed[normalized] = price;
                  }
                }
              }
            }
          }
          resolve(parsed);
        } catch (e) {
          resolve({});
        }
      });
    }).on('error', () => resolve({}));
  });
}

// Master updater combining all sources
async function fetchGasStationPrices() {
  try {
    console.log("🔄 Fetching fuel prices from all sources...");
    const [wogPrice, upgPrice, minfinData] = await Promise.all([
      fetchWogDirect(),
      fetchUpgDirect(),
      fetchMinfinPrices()
    ]);

    const finalPrices = { ...minfinData };
    if (wogPrice) finalPrices['WOG'] = wogPrice;
    if (upgPrice) finalPrices['UPG'] = upgPrice;

    const entries = Object.entries(finalPrices);
    if (entries.length > 0) {
      entries.forEach(([st, pr]) => {
        db.run(`INSERT INTO fuel_prices (station, price, fuel_type, updated_at) 
                VALUES (?, ?, 'A-95', CURRENT_TIMESTAMP)
                ON CONFLICT(station) DO UPDATE SET price = excluded.price, updated_at = CURRENT_TIMESTAMP`, 
                [st, pr]);
      });
      console.log(`✅ Updated fuel prices for ${entries.length} stations:`, finalPrices);
    }
    return finalPrices;
  } catch (err) {
    console.error("Failed to update fuel prices:", err.message);
    return null;
  }
}

// Initial fetch on start and repeat every 4 hours (multiple times a day)
setTimeout(fetchGasStationPrices, 3000);
setInterval(fetchGasStationPrices, 4 * 60 * 60 * 1000);

// API to get fuel prices
app.get('/api/fuel-prices', (req, res) => {
  db.all(`SELECT station, price, fuel_type, updated_at FROM fuel_prices ORDER BY price DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// API to force refresh fuel prices
app.post('/api/fuel-prices/refresh', async (req, res) => {
  await fetchGasStationPrices();
  db.all(`SELECT station, price, fuel_type, updated_at FROM fuel_prices ORDER BY price DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, prices: rows || [] });
  });
});

// API for user settings (e.g. fuel price)
app.get('/api/settings', (req, res) => {
  db.all(`SELECT key, value FROM settings`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const settings = {};
    (rows || []).forEach(r => { settings[r.key] = r.value; });
    res.json(settings);
  });
});

app.post('/api/settings', (req, res) => {
  const { fuel_price } = req.body;
  if (fuel_price) {
    db.run(`INSERT INTO settings (key, value) VALUES ('fuel_price', ?) 
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`, 
            [String(fuel_price)], 
            (err) => {
              if (err) return res.status(500).json({ error: err.message });
              res.json({ success: true, fuel_price });
            });
  } else {
    res.status(400).json({ error: 'No fuel_price provided' });
  }
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
    console.log("Configured WebApp URL:", webAppUrl);

    bot.start((ctx) => {
      console.log("💬 RECEIVED /start COMMAND!");
      ctx.reply('Привіт! Ваша телеметрія готова.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Відкрити OBD Графіки", web_app: { url: webAppUrl } }]
          ]
        }
      }).then(() => {
        console.log("✅ Reply successfully sent to user!");
      }).catch((e) => {
        console.error("❌ Failed to send reply (maybe URL is invalid?):", e);
      });
    });

    bot.on('message', (ctx) => {
      console.log("📩 Received a text message:", ctx.message?.text);
    });
    
    console.log("Calling bot.launch() (This will start an infinite polling loop)...");
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
