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

    // 4. Performance Indexes (Optimized for 50k+ records on long drives)
    db.run(`CREATE INDEX IF NOT EXISTS idx_obd_records_trip_id ON obd_records (trip_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_obd_records_trip_speed ON obd_records (trip_id, speed)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_obd_records_timestamp ON obd_records (id DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_obd_records_gps ON obd_records (trip_id, lat, lon)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_trips_status ON trips (status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_trips_id_desc ON trips (id DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_trips_start_time ON trips (start_time)`);

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

    // Default fuel price & base vehicle odometer if not exists
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('fuel_price', '58.50')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('odometer_base', '215000')`);

    // 7. Service & Maintenance Items table
    db.run(`CREATE TABLE IF NOT EXISTS service_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      interval_km INTEGER NOT NULL,
      interval_months INTEGER DEFAULT 12,
      last_service_odometer REAL DEFAULT 0,
      last_service_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      icon TEXT DEFAULT '🔧',
      notes TEXT DEFAULT ''
    )`);

    // 8. Service & Maintenance Logs history table
    db.run(`CREATE TABLE IF NOT EXISTS service_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER,
      title TEXT NOT NULL,
      odometer REAL DEFAULT 0,
      cost REAL DEFAULT 0,
      date DATETIME DEFAULT CURRENT_TIMESTAMP,
      notes TEXT DEFAULT ''
    )`);

    // Seed default Pajero 4 maintenance items if table is empty
    db.get("SELECT COUNT(*) as count FROM service_items", (err, row) => {
      if (!err && row && row.count === 0) {
        const defaultItems = [
          ['🛢️ Моторне мастило та фільтр', 'engine', 8000, 6, 210000, '5W-30 / 5W-40, об\'єм 4.8 л'],
          ['💨 Повітряний фільтр двигуна', 'filters', 15000, 12, 210000, 'Перевірка щосезону'],
          ['🌬️ Салонний фільтр (кондиціонера)', 'filters', 15000, 12, 210000, 'Вугільний або стандартний'],
          ['⚙️ Масло в АКПП (ATF SP-III / PA)', 'transmission', 45000, 24, 180000, 'Повна або часткова заміна'],
          ['🚜 Масло в роздатці Super Select', 'transmission', 40000, 24, 180000, '75W-90 GL-4, об\'єм ~2.3 л'],
          ['🚙 Масло в мостах (перед/зад)', 'transmission', 40000, 24, 180000, '80W-90 GL-5, задній міст з LSD/блокуванням'],
          ['🛑 Гальмівні колодки (перед/зад)', 'brakes', 30000, 24, 195000, 'Перевірка товщини фрикційного шару'],
          ['💧 Гальмівна рідина (DOT 4)', 'fluids', 40000, 24, 180000, 'Заміна кожні 2 роки'],
          ['⚡ Свічки запалювання (Іридій)', 'engine', 60000, 36, 170000, 'NGK Laser Iridium / Denso Iridium Tough'],
          ['❄️ Охолоджуюча рідина (Антифриз)', 'fluids', 60000, 36, 170000, 'Super Long Life Coolant Premium']
        ];
        for (const it of defaultItems) {
          db.run(
            `INSERT INTO service_items (title, category, interval_km, interval_months, last_service_odometer, notes) VALUES (?, ?, ?, ?, ?, ?)`,
            it
          );
        }
      }
    });

    // 9. Auto-fix historical speed glitches > 185 km/h and recalculate stats
    db.run(`UPDATE obd_records SET speed = 0 WHERE speed > 185`);
    db.run(`
      UPDATE trips SET 
        max_speed = (SELECT COALESCE(MAX(speed), 0) FROM obd_records WHERE trip_id = trips.id AND speed <= 185),
        avg_speed = (SELECT COALESCE(AVG(speed), 0) FROM obd_records WHERE trip_id = trips.id AND speed > 0 AND speed <= 185)
      WHERE max_speed > 185 OR avg_speed > 185
    `);

    // 10. Auto-complete stale active trips
    db.run(`
      UPDATE trips 
      SET status = 'completed', 
          end_time = COALESCE((SELECT MAX(timestamp) FROM obd_records WHERE trip_id = trips.id), start_time)
      WHERE status = 'active' 
        AND (strftime('%s', 'now') - strftime('%s', COALESCE((SELECT MAX(timestamp) FROM obd_records WHERE trip_id = trips.id), start_time))) > 900
    `);
  });
}

initDatabase();

module.exports = db;
