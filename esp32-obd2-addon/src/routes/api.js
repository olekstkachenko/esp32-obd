const express = require('express');
const router = express.Router();
const db = require('../db');
const tripService = require('../services/tripService');
const fuelScraper = require('../services/fuelScraper');

// Device Diagnostics In-Memory Buffer
let deviceLogs = [];
let latestDeviceStatus = {
  wifi: 'unknown',
  bt: 'disconnected',
  last_seen: null
};

// Device Log Endpoint
router.post('/device/log', (req, res) => {
  const { message, level, bt_status, wifi_status } = req.body;
  const timestamp = new Date().toLocaleTimeString('uk-UA');
  
  if (message) {
    const entry = { timestamp, level: level || 'info', message };
    deviceLogs.push(entry);
    if (deviceLogs.length > 100) deviceLogs.shift();
  }

  if (bt_status) latestDeviceStatus.bt = bt_status;
  if (wifi_status) latestDeviceStatus.wifi = wifi_status;
  latestDeviceStatus.last_seen = new Date().toISOString();

  res.json({ success: true });
});

router.get('/device/status', (req, res) => {
  res.json({
    status: latestDeviceStatus,
    logs: deviceLogs
  });
});

// 1. Post single OBD record from ESP32
router.post('/obd', async (req, res) => {
  const { rpm, speed, temp, voltage, fuel_rate } = req.body;
  const now = Date.now();
  
  try {
      const tripId = await tripService.ensureActiveTrip();
      const lastTime = tripService.getLastRecordTime();
      const timeDiffSeconds = lastTime ? (now - lastTime) / 1000.0 : 0;
      tripService.setLastRecordTime(now);

      db.run(`INSERT INTO obd_records (trip_id, rpm, speed, temp, voltage, fuel_rate) VALUES (?, ?, ?, ?, ?, ?)`, 
          [tripId, rpm, speed, temp, voltage, fuel_rate], 
          async function(err) {
              if (err) return res.status(500).json({ error: err.message });
              tripService.updateTripStats(tripId, speed || 0, fuel_rate || 0, timeDiffSeconds);
              res.status(201).json({ success: true, tripId });
      });
  } catch(e) {
      res.status(500).json({ error: e.message });
  }
});

// 2. Post offline batch of OBD records from ESP32
router.post('/obd/batch', async (req, res) => {
  const { records } = req.body;
  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'Масив записів порожній' });
  }

  try {
    const tripId = await tripService.ensureActiveTrip();
    let totalAddedDist = 0;
    let totalAddedFuel = 0;
    let batchMaxSpeed = 0;

    db.serialize(() => {
      db.run("BEGIN TRANSACTION");
      const stmt = db.prepare(`INSERT INTO obd_records (trip_id, rpm, speed, temp, voltage, fuel_rate) VALUES (?, ?, ?, ?, ?, ?)`);

      records.forEach((r) => {
        const rpm = r.rpm || 0;
        const speed = r.speed || 0;
        const temp = r.temp || 0;
        const volt = r.voltage || r.volt || 0;
        const fuel = r.fuel_rate || r.fuel || 0;
        const dt = (r.dt && r.dt > 0 && r.dt <= 60) ? r.dt : 1.0;

        if (speed > batchMaxSpeed) batchMaxSpeed = speed;

        const dist = (speed > 0) ? (speed * (dt / 3600.0)) : 0;
        totalAddedDist += dist;

        if (fuel > 0) {
          totalAddedFuel += fuel * (dt / 3600.0);
        } else if (dist > 0) {
          totalAddedFuel += (dist * 7.5) / 100.0;
        }

        stmt.run(tripId, rpm, speed, temp, volt, fuel);
      });

      stmt.finalize();

      db.run(`UPDATE trips SET 
              distance_km = distance_km + ?, 
              fuel_liters = fuel_liters + ?,
              avg_speed = (SELECT AVG(speed) FROM obd_records WHERE trip_id = ? AND speed > 0),
              max_speed = MAX(COALESCE(max_speed, 0), ?)
              WHERE id = ?`, 
              [totalAddedDist, totalAddedFuel, tripId, batchMaxSpeed, tripId], 
              (err) => {
                if (err) {
                  db.run("ROLLBACK");
                  return res.status(500).json({ error: err.message });
                }
                db.run("COMMIT");
                console.log(`[Batch Sync] Processed ${records.length} offline records for Trip #${tripId}`);
                res.status(201).json({ success: true, count: records.length, tripId });
              });
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// 3. Get latest dashboard data
router.get('/data', (req, res) => {
  const activeId = tripService.getCurrentTripId();

  db.get(`SELECT * FROM obd_records ORDER BY id DESC LIMIT 1`, (err, latestRecord) => {
    if (err) return res.status(500).json({ error: err.message });

    if (!activeId) {
      return res.json({
        latest: latestRecord || { rpm: 0, speed: 0, temp: 0, voltage: 0, fuel_rate: 0 },
        trip: { distance_km: 0, avg_speed: 0, max_speed: 0 }
      });
    }

    db.get(`SELECT distance_km, avg_speed, max_speed FROM trips WHERE id = ?`, [activeId], (err, tripStats) => {
      if (err) return res.status(500).json({ error: err.message });

      res.json({
        latest: latestRecord || { rpm: 0, speed: 0, temp: 0, voltage: 0, fuel_rate: 0 },
        trip: tripStats || { distance_km: 0, avg_speed: 0, max_speed: 0 }
      });
    });
  });
});

// 4. Get last 60 records for live chart
router.get('/history', (req, res) => {
  db.all(`SELECT * FROM (SELECT * FROM obd_records ORDER BY id DESC LIMIT 60) ORDER BY id ASC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// 5. Trips Archive API
router.get('/trips', (req, res) => {
  db.get(`SELECT value FROM settings WHERE key = 'fuel_price'`, (err, row) => {
    const fuelPrice = parseFloat(row ? row.value : '58.50') || 58.50;

    const sql = `
      SELECT t.id, t.start_time, t.end_time, t.status,
             ROUND(COALESCE(t.distance_km, 0), 2) as distance_km,
             ROUND(COALESCE(t.avg_speed, 0), 1) as avg_speed,
             ROUND(COALESCE(t.max_speed, 0), 1) as max_speed,
             ROUND(COALESCE(t.fuel_liters, 0), 2) as fuel_liters,
             CASE 
               WHEN strftime('%s', t.end_time) IS NOT NULL 
               THEN (strftime('%s', t.end_time) - strftime('%s', t.start_time))
               ELSE (strftime('%s', 'now') - strftime('%s', t.start_time))
             END as duration_seconds
      FROM trips t
      ORDER BY t.id DESC
    `;

    db.all(sql, [], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });

      const trips = (rows || []).map(r => {
        const dist = r.distance_km || 0;
        const fuel = r.fuel_liters || 0;
        const l_per_100km = dist > 0 ? (fuel / dist) * 100 : 0;
        const trip_cost_uah = fuel * fuelPrice;

        return {
          ...r,
          l_per_100km: parseFloat(l_per_100km.toFixed(1)),
          trip_cost_uah: parseFloat(trip_cost_uah.toFixed(2))
        };
      });

      res.json(trips);
    });
  });
});

// 6. Get trip details
router.get('/trips/:id', (req, res) => {
  const tripId = req.params.id;
  db.get(`SELECT * FROM trips WHERE id = ?`, [tripId], (err, trip) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!trip) return res.status(404).json({ error: 'Поїздку не знайдено' });

    db.all(`SELECT * FROM obd_records WHERE trip_id = ? ORDER BY id ASC`, [tripId], (err, records) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ trip, records: records || [] });
    });
  });
});

// 7. Delete trip
router.delete('/trips/:id', (req, res) => {
  const tripId = req.params.id;
  db.run(`DELETE FROM trips WHERE id = ?`, [tripId], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, deletedId: tripId });
  });
});

// 8. Finish active trip
router.post('/trips/finish', async (req, res) => {
  try {
    const finishedId = await tripService.finishCurrentTrip();
    res.json({ success: true, finishedTripId: finishedId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 9. Fuel Prices API
router.get('/fuel-prices', (req, res) => {
  db.all(`SELECT station, price, fuel_type, updated_at FROM fuel_prices ORDER BY price ASC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

router.post('/fuel-prices/refresh', async (req, res) => {
  try {
    const prices = await fuelScraper.fetchGasStationPrices();
    res.json({ success: true, prices });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 10. Settings API (fuel price)
router.get('/settings', (req, res) => {
  db.all(`SELECT key, value FROM settings`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const settings = {};
    (rows || []).forEach(r => settings[r.key] = r.value);
    res.json(settings);
  });
});

router.post('/settings', (req, res) => {
  const { fuel_price } = req.body;
  if (!fuel_price) return res.status(400).json({ error: 'Вкажіть fuel_price' });

  db.run(`INSERT INTO settings (key, value, updated_at) VALUES ('fuel_price', ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
          [String(fuel_price)], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, fuel_price });
          });
});

module.exports = router;
