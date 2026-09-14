const express = require('express');
const router = express.Router();
const db = require('../db');
const tripService = require('../services/tripService');
const fuelScraper = require('../services/fuelScraper');

// In-Memory Ring Buffer for ESP32 Diagnostic Logs
const MAX_LOGS = 100;
const deviceLogs = [];
const latestDeviceStatus = {
  wifi: 'unknown',
  bt: 'disconnected',
  last_seen: null
};

// 1. Device Diagnostics Endpoint
router.post('/device/log', (req, res) => {
  const { message, level, bt_status, wifi_status } = req.body;
  const timestamp = new Date().toLocaleTimeString('uk-UA');
  
  if (message) {
    deviceLogs.push({ timestamp, level: level || 'info', message: String(message) });
    if (deviceLogs.length > MAX_LOGS) deviceLogs.shift();
  }

  if (bt_status) latestDeviceStatus.bt = String(bt_status);
  if (wifi_status) latestDeviceStatus.wifi = String(wifi_status);
  latestDeviceStatus.last_seen = new Date().toISOString();

  res.json({ success: true });
});

router.get('/device/status', (req, res) => {
  res.json({
    status: latestDeviceStatus,
    logs: deviceLogs
  });
});

// 2. Single OBD Record Ingestion from ESP32
router.post('/obd', async (req, res) => {
  const { rpm = 0, speed = 0, temp = 0, voltage = 0, fuel_rate = 0 } = req.body;
  const now = Date.now();
  
  try {
    const tripId = await tripService.ensureActiveTrip();
    const lastTime = tripService.getLastRecordTime();
    const timeDiffSeconds = lastTime ? Math.min((now - lastTime) / 1000.0, 60) : 0;
    tripService.setLastRecordTime(now);

    await db.runAsync(
      `INSERT INTO obd_records (trip_id, rpm, speed, temp, voltage, fuel_rate) VALUES (?, ?, ?, ?, ?, ?)`,
      [tripId, Number(rpm) || 0, Number(speed) || 0, Number(temp) || 0, Number(voltage) || 0, Number(fuel_rate) || 0]
    );

    await tripService.updateTripStats(tripId, Number(speed) || 0, Number(fuel_rate) || 0, timeDiffSeconds);
    res.status(201).json({ success: true, tripId });
  } catch (err) {
    console.error('[API /obd] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 3. Batch OBD Records Ingestion (Offline Buffering Sync)
router.post('/obd/batch', async (req, res) => {
  const { records } = req.body;
  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'Records array is empty' });
  }

  try {
    const tripId = await tripService.ensureActiveTrip();
    let totalAddedDist = 0;
    let totalAddedFuel = 0;
    let batchMaxSpeed = 0;

    await new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        const stmt = db.prepare(`INSERT INTO obd_records (trip_id, rpm, speed, temp, voltage, fuel_rate) VALUES (?, ?, ?, ?, ?, ?)`);

        for (const r of records) {
          const rpm = Number(r.rpm) || 0;
          const speed = Number(r.speed) || 0;
          const temp = Number(r.temp) || 0;
          const volt = Number(r.voltage || r.volt) || 0;
          const fuel = Number(r.fuel_rate || r.fuel) || 0;
          const dt = (r.dt && r.dt > 0 && r.dt <= 60) ? Number(r.dt) : 1.0;

          if (speed > batchMaxSpeed) batchMaxSpeed = speed;

          const dist = (speed > 0) ? (speed * (dt / 3600.0)) : 0;
          totalAddedDist += dist;

          if (fuel > 0) {
            totalAddedFuel += fuel * (dt / 3600.0);
          } else if (dist > 0) {
            totalAddedFuel += (dist * 7.5) / 100.0;
          }

          stmt.run(tripId, rpm, speed, temp, volt, fuel);
        }

        stmt.finalize();

        db.run(
          `UPDATE trips SET 
            distance_km = distance_km + ?, 
            fuel_liters = fuel_liters + ?,
            avg_speed = (SELECT COALESCE(AVG(speed), 0) FROM obd_records WHERE trip_id = ? AND speed > 0),
            max_speed = MAX(COALESCE(max_speed, 0), ?)
          WHERE id = ?`,
          [totalAddedDist, totalAddedFuel, tripId, batchMaxSpeed, tripId],
          (err) => {
            if (err) {
              db.run('ROLLBACK');
              return reject(err);
            }
            db.run('COMMIT');
            resolve();
          }
        );
      });
    });

    console.log(`[Batch Sync] Processed ${records.length} records for Trip #${tripId} (+${totalAddedDist.toFixed(2)} km)`);
    res.status(201).json({ success: true, count: records.length, tripId });
  } catch (err) {
    console.error('[API /obd/batch] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 4. Latest Telemetry & Active Trip Stats
router.get('/data', async (req, res) => {
  try {
    const activeId = tripService.getCurrentTripId();
    const latestRecord = await db.getAsync(`SELECT * FROM obd_records ORDER BY id DESC LIMIT 1`);
    
    let tripStats = { distance_km: 0, avg_speed: 0, max_speed: 0 };
    if (activeId) {
      const row = await db.getAsync(`SELECT distance_km, avg_speed, max_speed FROM trips WHERE id = ?`, [activeId]);
      if (row) tripStats = row;
    }

    res.json({
      latest: latestRecord || { rpm: 0, speed: 0, temp: 0, voltage: 0, fuel_rate: 0 },
      trip: tripStats
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Last 60 Telemetry Records for Live Charts
router.get('/history', async (req, res) => {
  try {
    const rows = await db.allAsync(`
      SELECT * FROM (
        SELECT id, rpm, speed, temp, voltage, fuel_rate, timestamp 
        FROM obd_records 
        ORDER BY id DESC LIMIT 60
      ) ORDER BY id ASC
    `);
    res.json(rows || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Trips Archive with Fuel Cost Calculations
router.get('/trips', async (req, res) => {
  try {
    const settingRow = await db.getAsync(`SELECT value FROM settings WHERE key = 'fuel_price'`);
    const fuelPrice = parseFloat(settingRow ? settingRow.value : '58.50') || 58.50;

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

    const rows = await db.allAsync(sql);
    const trips = rows.map((r) => {
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Trip Details Modal Data
router.get('/trips/:id', async (req, res) => {
  const tripId = parseInt(req.params.id, 10);
  if (isNaN(tripId)) return res.status(400).json({ error: 'Invalid trip ID' });

  try {
    const settingRow = await db.getAsync(`SELECT value FROM settings WHERE key = 'fuel_price'`);
    const fuelPrice = parseFloat(settingRow ? settingRow.value : '58.50') || 58.50;

    const trip = await db.getAsync(`SELECT * FROM trips WHERE id = ?`, [tripId]);
    if (!trip) return res.status(404).json({ error: 'Trip not found' });

    const records = await db.allAsync(`SELECT timestamp, speed, rpm, temp, voltage FROM obd_records WHERE trip_id = ? ORDER BY id ASC`, [tripId]);

    const dist = trip.distance_km || 0;
    const fuel = trip.fuel_liters || 0;
    trip.l_per_100km = dist > 0 ? parseFloat(((fuel / dist) * 100).toFixed(1)) : 0;
    trip.trip_cost_uah = parseFloat((fuel * fuelPrice).toFixed(2));

    res.json({ trip, records });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Delete Trip
router.delete('/trips/:id', async (req, res) => {
  const tripId = parseInt(req.params.id, 10);
  if (isNaN(tripId)) return res.status(400).json({ error: 'Invalid trip ID' });

  try {
    await db.runAsync(`DELETE FROM trips WHERE id = ?`, [tripId]);
    res.json({ success: true, message: `Trip #${tripId} deleted` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Finish Active Trip Manually
router.post('/trips/finish', async (req, res) => {
  try {
    const finishedId = await tripService.finishCurrentTrip();
    res.json({ success: true, finishedId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 10. Gas Stations Fuel Prices
router.get('/fuel-prices', async (req, res) => {
  try {
    const rows = await db.allAsync(`SELECT station, price, fuel_type, updated_at FROM fuel_prices ORDER BY price ASC`);
    res.json(rows || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/fuel-prices/refresh', async (req, res) => {
  try {
    const prices = await fuelScraper.fetchGasStationPrices();
    res.json({ success: true, prices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 11. Custom Settings
router.get('/settings', async (req, res) => {
  try {
    const rows = await db.allAsync(`SELECT key, value FROM settings`);
    const settings = {};
    (rows || []).forEach(r => { settings[r.key] = r.value; });
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/settings', async (req, res) => {
  const { fuel_price } = req.body;
  if (!fuel_price || isNaN(parseFloat(fuel_price))) {
    return res.status(400).json({ error: 'Invalid fuel price' });
  }

  try {
    await db.runAsync(
      `INSERT INTO settings (key, value, updated_at) VALUES ('fuel_price', ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      [String(fuel_price)]
    );
    res.json({ success: true, fuel_price });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
