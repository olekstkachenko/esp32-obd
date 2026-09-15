const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const config = require('./config');

// Ensure database directory exists
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

// Promisified helper methods for clean async/await queries
db.getAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
});

db.allAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
});

db.runAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function(err) {
    err ? reject(err) : resolve({ lastID: this.lastID, changes: this.changes });
  });
});

function initDatabase() {
  db.serialize(() => {
    // 1. Performance PRAGMAs: WAL mode, Normal Sync, Busy Timeout
    db.run("PRAGMA journal_mode = WAL;");
    db.run("PRAGMA synchronous = NORMAL;");
    db.run("PRAGMA busy_timeout = 5000;");
    db.run("PRAGMA foreign_keys = ON;");

    // 2. Trips table
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

    // 3. OBD Records table
    db.run(`CREATE TABLE IF NOT EXISTS obd_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      rpm REAL,
      speed REAL,
      temp REAL,
      voltage REAL,
      fuel_rate REAL,
      lat REAL,
      lon REAL,
      alt REAL,
      sat INTEGER,
      FOREIGN KEY (trip_id) REFERENCES trips (id) ON DELETE CASCADE
    )`);

    // Schema migrations for obd_records
    db.run(`ALTER TABLE obd_records ADD COLUMN fuel_rate REAL`, () => {});
    db.run(`ALTER TABLE obd_records ADD COLUMN trip_id INTEGER`, () => {});
    db.run(`ALTER TABLE obd_records ADD COLUMN lat REAL`, () => {});
    db.run(`ALTER TABLE obd_records ADD COLUMN lon REAL`, () => {});
    db.run(`ALTER TABLE obd_records ADD COLUMN alt REAL`, () => {});
    db.run(`ALTER TABLE obd_records ADD COLUMN sat INTEGER`, () => {});

    // 4. Performance Indexes
    db.run(`CREATE INDEX IF NOT EXISTS idx_obd_records_trip_id ON obd_records (trip_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_obd_records_timestamp ON obd_records (id DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_obd_records_gps ON obd_records (trip_id, lat, lon)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_trips_status ON trips (status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_trips_id_desc ON trips (id DESC)`);

    // 5. Gas station fuel prices table
    db.run(`CREATE TABLE IF NOT EXISTS fuel_prices (
      station TEXT PRIMARY KEY,
      price REAL,
      fuel_type TEXT DEFAULT 'A-95',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 6. App settings table
    db.run(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Default fuel price if not exists
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('fuel_price', '58.50')`);
  });
}

initDatabase();

module.exports = db;
