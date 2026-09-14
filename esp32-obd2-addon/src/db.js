const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const config = require('./config');

// Ensure directory exists
const dbDir = path.dirname(config.DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(config.DB_PATH, (err) => {
  if (err) {
    console.error(`❌ Failed to connect to SQLite DB at ${config.DB_PATH}:`, err.message);
  } else {
    console.log(`💾 SQLite Database connected at: ${config.DB_PATH}`);
  }
});

function initDatabase() {
  db.serialize(() => {
    // Trips table
    db.run(`CREATE TABLE IF NOT EXISTS trips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      end_time DATETIME,
      status TEXT DEFAULT 'active',
      max_speed REAL DEFAULT 0,
      distance_km REAL DEFAULT 0,
      fuel_liters REAL DEFAULT 0,
      avg_speed REAL DEFAULT 0
    )`);

    // Schema migrations for trips
    db.run(`ALTER TABLE trips ADD COLUMN max_speed REAL DEFAULT 0`, () => {});
    db.run(`ALTER TABLE trips ADD COLUMN distance_km REAL DEFAULT 0`, () => {});
    db.run(`ALTER TABLE trips ADD COLUMN fuel_liters REAL DEFAULT 0`, () => {});
    db.run(`ALTER TABLE trips ADD COLUMN avg_speed REAL DEFAULT 0`, () => {});

    // OBD Records table
    db.run(`CREATE TABLE IF NOT EXISTS obd_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      rpm REAL,
      speed REAL,
      temp REAL,
      voltage REAL,
      fuel_rate REAL,
      FOREIGN KEY (trip_id) REFERENCES trips (id) ON DELETE CASCADE
    )`);

    // Schema migrations for obd_records
    db.run(`ALTER TABLE obd_records ADD COLUMN fuel_rate REAL`, () => {});
    db.run(`ALTER TABLE obd_records ADD COLUMN trip_id INTEGER`, () => {});

    // Gas station fuel prices table
    db.run(`CREATE TABLE IF NOT EXISTS fuel_prices (
      station TEXT PRIMARY KEY,
      price REAL,
      fuel_type TEXT DEFAULT 'A-95',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // App settings table (for custom fuel price etc)
    db.run(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Insert default fuel price if not exists
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('fuel_price', '58.50')`);
  });
}

initDatabase();

module.exports = db;
