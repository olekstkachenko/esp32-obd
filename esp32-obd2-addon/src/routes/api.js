const express = require('express');
const router = express.Router();
const db = require('../db');
const tripService = require('../services/tripService');
const fuelScraper = require('../services/fuelScraper');

// In-Memory Ring Buffer for ESP32 Diagnostic Logs
const MAX_LOGS = 200;
const deviceLogs = [];
const latestDeviceStatus = {
  wifi: 'unknown',
  bt: 'disconnected',
  ip: '--',
  free_heap: '--',
  rssi: null,
  last_seen: null
};

// 1. Device Diagnostics Endpoint
router.post('/device/log', (req, res) => {
  const { message, level, bt_status, wifi_status, free_heap, rssi, ip } = req.body;
  const now = new Date();
  const timestamp = now.toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const iso = now.toISOString();
  
  if (message) {
    deviceLogs.push({ timestamp, iso, level: level || 'info', message: String(message) });
    if (deviceLogs.length > MAX_LOGS) deviceLogs.shift();
  }

  if (bt_status) latestDeviceStatus.bt = String(bt_status);
  if (wifi_status) latestDeviceStatus.wifi = String(wifi_status);
  if (free_heap !== undefined) latestDeviceStatus.free_heap = free_heap;
  if (rssi !== undefined) latestDeviceStatus.rssi = rssi;
  if (ip) latestDeviceStatus.ip = String(ip);
  latestDeviceStatus.last_seen = new Date().toISOString();

  res.json({ success: true, count: deviceLogs.length });
});

router.get('/device/status', (req, res) => {
  const now = Date.now();
  const lastSeenMs = latestDeviceStatus.last_seen ? new Date(latestDeviceStatus.last_seen).getTime() : 0;
  const isOnline = lastSeenMs > 0 && (now - lastSeenMs < 30000);

  const cleanStatus = isOnline ? latestDeviceStatus : {
    wifi: 'offline',
    bt: 'disconnected',
    ip: '--',
    free_heap: '--',
    rssi: null,
    last_seen: null
  };

  res.json({
    status: cleanStatus,
    is_online: isOnline,
    logs: deviceLogs
  });
});

router.delete('/device/logs', (req, res) => {
  deviceLogs.length = 0;
  latestDeviceStatus.wifi = 'unknown';
  latestDeviceStatus.bt = 'disconnected';
  latestDeviceStatus.ip = '--';
  latestDeviceStatus.free_heap = '--';
  latestDeviceStatus.rssi = null;
  latestDeviceStatus.last_seen = null;
  res.json({ success: true, message: 'Logs and diagnostics state cleared' });
});

// 2. Single OBD Record Ingestion from ESP32
router.post('/obd', async (req, res) => {
  const { rpm = 0, speed = 0, temp = 0, voltage = 0, fuel_rate = 0, lat, lon, alt, sat } = req.body || {};
  const now = Date.now();
  
  const cleanRpm = Math.max(0, Math.min(10000, Number(rpm) || 0));
  const cleanSpeed = Math.max(0, Math.min(185, Number(speed) || 0));
  const cleanTemp = Math.max(-50, Math.min(150, Number(temp) || 0));
  const cleanVolt = Math.max(0, Math.min(30, Number(voltage) || 0));
  const cleanFuel = Math.max(0, Math.min(100, Number(fuel_rate) || 0));
  const cleanLat = (lat !== undefined && lat !== null && !isNaN(lat) && Math.abs(lat) <= 90) ? Number(lat) : null;
  const cleanLon = (lon !== undefined && lon !== null && !isNaN(lon) && Math.abs(lon) <= 180) ? Number(lon) : null;
  const cleanAlt = (alt !== undefined && alt !== null && !isNaN(alt)) ? Number(alt) : null;
  const cleanSat = (sat !== undefined && sat !== null && !isNaN(sat)) ? parseInt(sat, 10) : null;

  try {
    const tripId = await tripService.ensureActiveTrip();
    const lastTime = tripService.getLastRecordTime();
    const timeDiffSeconds = lastTime ? Math.min((now - lastTime) / 1000.0, 60) : 0;
    tripService.setLastRecordTime(now);

    await db.runAsync(
      `INSERT INTO obd_records (trip_id, rpm, speed, temp, voltage, fuel_rate, lat, lon, alt, sat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tripId, cleanRpm, cleanSpeed, cleanTemp, cleanVolt, cleanFuel, cleanLat, cleanLon, cleanAlt, cleanSat]
    );

    await tripService.updateTripStats(tripId, cleanSpeed, cleanFuel, timeDiffSeconds);
    res.status(201).json({ success: true, tripId });
  } catch (err) {
    console.error('[API /obd] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 3. Batch OBD Records Ingestion (Offline Buffering Sync)
router.post('/obd/batch', async (req, res) => {
  const { records } = req.body || {};
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
        const stmt = db.prepare(`INSERT INTO obd_records (trip_id, rpm, speed, temp, voltage, fuel_rate, lat, lon, alt, sat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

        for (const r of records) {
          const rpm = Math.max(0, Math.min(10000, Number(r.rpm) || 0));
          const speed = Math.max(0, Math.min(185, Number(r.speed) || 0));
          const temp = Math.max(-50, Math.min(150, Number(r.temp) || 0));
          const volt = Math.max(0, Math.min(30, Number(r.voltage || r.volt) || 0));
          const fuel = Math.max(0, Math.min(100, Number(r.fuel_rate || r.fuel) || 0));
          const dt = (r.dt && Number(r.dt) > 0 && Number(r.dt) <= 60) ? Number(r.dt) : 1.0;
          const lat = (r.lat !== undefined && r.lat !== null && !isNaN(r.lat) && Math.abs(r.lat) <= 90) ? Number(r.lat) : null;
          const lon = (r.lon !== undefined && r.lon !== null && !isNaN(r.lon) && Math.abs(r.lon) <= 180) ? Number(r.lon) : null;
          const alt = (r.alt !== undefined && r.alt !== null && !isNaN(r.alt)) ? Number(r.alt) : null;
          const sat = (r.sat !== undefined && r.sat !== null && !isNaN(r.sat)) ? parseInt(r.sat, 10) : null;

          if (speed > batchMaxSpeed) batchMaxSpeed = speed;

          const dist = (speed > 0) ? (speed * (dt / 3600.0)) : 0;
          totalAddedDist += dist;

          if (fuel > 0) {
            totalAddedFuel += fuel * (dt / 3600.0);
          } else if (dist > 0) {
            totalAddedFuel += (dist * 7.5) / 100.0;
          }

          stmt.run(tripId, rpm, speed, temp, volt, fuel, lat, lon, alt, sat);
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

    res.status(201).json({ success: true, count: records.length, tripId });
  } catch (err) {
    console.error('[API /obd/batch] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Helper function to safely parse DB timestamps regardless of timezone format
function parseTimestamp(ts) {
  if (!ts) return 0;
  const str = String(ts).trim();
  const isoStr = str.includes('T') ? str : (str.replace(' ', 'T') + (str.endsWith('Z') ? '' : 'Z'));
  const ms = new Date(isoStr).getTime();
  return isNaN(ms) ? 0 : ms;
}

// 4. Latest Telemetry & Active Trip Stats (With Stale Offline Protection)
router.get('/data', async (req, res) => {
  try {
    const activeId = tripService.getCurrentTripId();
    const latestRecord = await db.getAsync(`SELECT * FROM obd_records ORDER BY id DESC LIMIT 1`);
    
    let tripStats = { distance_km: 0, avg_speed: 0, max_speed: 0 };
    if (activeId) {
      const row = await db.getAsync(`SELECT distance_km, avg_speed, max_speed FROM trips WHERE id = ?`, [activeId]);
      if (row) tripStats = row;
    }

    // Check if device is actively online (heartbeat/log in the last 25 seconds)
    const lastSeenMs = latestDeviceStatus.last_seen ? parseTimestamp(latestDeviceStatus.last_seen) : 0;
    const isOnline = lastSeenMs > 0 && (Date.now() - lastSeenMs < 25000);
    
    // Check if latest record was generated in the last 25 seconds (safe UTC parse)
    const recordTimeMs = latestRecord && latestRecord.timestamp ? parseTimestamp(latestRecord.timestamp) : 0;
    const isFreshRecord = recordTimeMs > 0 && (Date.now() - recordTimeMs < 25000);

    // If offline or record is old/stale, zero out the live gauges so users don't see frozen old data
    const liveData = (isOnline || isFreshRecord) && latestRecord 
      ? latestRecord 
      : { rpm: 0, speed: 0, temp: 0, voltage: 0, fuel_rate: 0 };

    res.json({
      latest: liveData,
      trip: tripStats,
      is_online: Boolean(isOnline),
      is_stale: !isOnline && !isFreshRecord
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4.1 Reset / Clear All Database Telemetry & Test Logs
router.post('/reset-data', async (req, res) => {
  try {
    await db.runAsync(`DELETE FROM obd_records`);
    await db.runAsync(`DELETE FROM trips`);
    deviceLogs.length = 0;
    latestDeviceStatus.last_seen = null;
    latestDeviceStatus.wifi = 'unknown';
    latestDeviceStatus.bt = 'disconnected';
    latestDeviceStatus.ip = '--';
    latestDeviceStatus.rssi = null;
    latestDeviceStatus.free_heap = '--';
    tripService.reset();
    res.json({ success: true, message: 'All telemetry records and test data purged' });
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

    const records = await db.allAsync(`SELECT timestamp, speed, rpm, temp, voltage, lat, lon, alt, sat FROM obd_records WHERE trip_id = ? ORDER BY id ASC`, [tripId]);

    const dist = trip.distance_km || 0;
    const fuel = trip.fuel_liters || 0;
    trip.l_per_100km = dist > 0 ? parseFloat(((fuel / dist) * 100).toFixed(1)) : 0;
    trip.trip_cost_uah = parseFloat((fuel * fuelPrice).toFixed(2));

    // Extract GPS summary
    const gpsPoints = records.filter(r => r.lat !== null && r.lon !== null);
    trip.has_gps = gpsPoints.length > 0;
    trip.gps_points_count = gpsPoints.length;

    res.json({ trip, records });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7.1 Export Trip Route to GPX 1.1 format
router.get('/trips/:id/gpx', async (req, res) => {
  const tripId = parseInt(req.params.id, 10);
  if (isNaN(tripId)) return res.status(400).send('Invalid trip ID');

  try {
    const trip = await db.getAsync(`SELECT * FROM trips WHERE id = ?`, [tripId]);
    if (!trip) return res.status(404).send('Trip not found');

    const points = await db.allAsync(`SELECT timestamp, speed, alt, lat, lon FROM obd_records WHERE trip_id = ? AND lat IS NOT NULL AND lon IS NOT NULL ORDER BY id ASC`, [tripId]);

    if (!points || points.length === 0) {
      return res.status(404).send('No GPS route points found for this trip');
    }

    const startTime = trip.start_time || points[0].timestamp;
    let gpx = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    gpx += `<gpx version="1.1" creator="Telematics Pro OBD2 ESP32" xmlns="http://www.topografix.com/GPX/1/1">\n`;
    gpx += `  <metadata>\n    <name>Поїздка #${tripId}</name>\n    <time>${new Date(startTime).toISOString()}</time>\n  </metadata>\n`;
    gpx += `  <trk>\n    <name>Поїздка #${tripId} (${trip.distance_km || 0} km)</name>\n    <trkseg>\n`;

    for (const p of points) {
      const timeIso = p.timestamp ? (p.timestamp.includes('T') ? p.timestamp : new Date(p.timestamp.replace(' ', 'T') + 'Z').toISOString()) : new Date().toISOString();
      const ele = p.alt ? `        <ele>${p.alt}</ele>\n` : '';
      const speedMs = p.speed ? (p.speed / 3.6).toFixed(2) : '0.00';
      gpx += `      <trkpt lat="${p.lat}" lon="${p.lon}">\n${ele}        <time>${timeIso}</time>\n        <speed>${speedMs}</speed>\n      </trkpt>\n`;
    }

    gpx += `    </trkseg>\n  </trk>\n</gpx>`;

    res.setHeader('Content-Type', 'application/gpx+xml');
    res.setHeader('Content-Disposition', `attachment; filename="trip-${tripId}.gpx"`);
    res.send(gpx);
  } catch (err) {
    res.status(500).send('Error generating GPX: ' + err.message);
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
  const { fuel_price } = req.body || {};
  const price = parseFloat(fuel_price);
  if (isNaN(price) || price <= 0 || price > 200) {
    return res.status(400).json({ error: 'Invalid fuel price. Must be a number between 1 and 200 UAH.' });
  }

  try {
    await db.runAsync(
      `INSERT INTO settings (key, value, updated_at) VALUES ('fuel_price', ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      [price.toFixed(2)]
    );
    res.json({ success: true, fuel_price: price.toFixed(2) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 12. Extended Analytics API
router.get('/analytics', async (req, res) => {
  const { period = 'month', from, to } = req.query;

  try {
    const settingRow = await db.getAsync(`SELECT value FROM settings WHERE key = 'fuel_price'`);
    const fuelPrice = parseFloat(settingRow ? settingRow.value : '58.50') || 58.50;

    let whereClause = '1=1';
    const params = [];

    if (from && to) {
      whereClause = `DATE(t.start_time) >= DATE(?) AND DATE(t.start_time) <= DATE(?)`;
      params.push(from, to);
    } else if (from) {
      whereClause = `DATE(t.start_time) >= DATE(?)`;
      params.push(from);
    } else if (period === 'today') {
      whereClause = `DATE(t.start_time) >= DATE('now', 'localtime', 'start of day')`;
    } else if (period === 'week') {
      whereClause = `DATE(t.start_time) >= DATE('now', '-7 days')`;
    } else if (period === 'month') {
      whereClause = `DATE(t.start_time) >= DATE('now', '-30 days')`;
    } else if (period === 'year') {
      whereClause = `DATE(t.start_time) >= DATE('now', '-365 days')`;
    }

    // 1. Overall Aggregates
    const aggSql = `
      SELECT 
        COUNT(t.id) as trips_count,
        ROUND(COALESCE(SUM(t.distance_km), 0), 2) as total_distance_km,
        ROUND(COALESCE(SUM(t.fuel_liters), 0), 2) as total_fuel_liters,
        COALESCE(MAX(t.max_speed), 0) as max_speed,
        ROUND(COALESCE(AVG(CASE WHEN t.avg_speed > 0 THEN t.avg_speed END), 0), 1) as avg_speed,
        COALESCE(SUM(
          CASE 
            WHEN strftime('%s', t.end_time) IS NOT NULL 
            THEN (strftime('%s', t.end_time) - strftime('%s', t.start_time))
            ELSE (strftime('%s', 'now') - strftime('%s', t.start_time))
          END
        ), 0) as total_duration_seconds
      FROM trips t
      WHERE ${whereClause}
    `;
    const agg = await db.getAsync(aggSql, params);

    const totalDist = agg ? agg.total_distance_km : 0;
    const totalFuel = agg ? agg.total_fuel_liters : 0;
    const totalCost = parseFloat((totalFuel * fuelPrice).toFixed(2));
    const avgConsumption = totalDist > 0 ? parseFloat(((totalFuel / totalDist) * 100).toFixed(1)) : 0;

    // 2. Daily Breakdown for Charts
    const dailySql = `
      SELECT 
        DATE(t.start_time) as date,
        COUNT(t.id) as trips_count,
        ROUND(COALESCE(SUM(t.distance_km), 0), 2) as distance_km,
        ROUND(COALESCE(SUM(t.fuel_liters), 0), 2) as fuel_liters,
        COALESCE(MAX(t.max_speed), 0) as max_speed,
        ROUND(COALESCE(AVG(CASE WHEN t.avg_speed > 0 THEN t.avg_speed END), 0), 1) as avg_speed
      FROM trips t
      WHERE ${whereClause}
      GROUP BY DATE(t.start_time)
      ORDER BY date ASC
    `;
    const dailyRows = await db.allAsync(dailySql, params);
    const daily = (dailyRows || []).map(d => ({
      ...d,
      cost_uah: parseFloat((d.fuel_liters * fuelPrice).toFixed(2)),
      l_per_100km: d.distance_km > 0 ? parseFloat(((d.fuel_liters / d.distance_km) * 100).toFixed(1)) : 0
    }));

    // 3. Speed / Driving Style Distribution from OBD Records for trips in this period
    const speedSql = `
      SELECT 
        COUNT(CASE WHEN r.speed > 0 AND r.speed < 50 THEN 1 END) as city_count,
        COUNT(CASE WHEN r.speed >= 50 AND r.speed <= 80 THEN 1 END) as mixed_count,
        COUNT(CASE WHEN r.speed > 80 THEN 1 END) as highway_count,
        COUNT(CASE WHEN r.speed == 0 AND r.rpm > 400 THEN 1 END) as idle_count,
        COUNT(r.id) as total_records
      FROM obd_records r
      INNER JOIN trips t ON r.trip_id = t.id
      WHERE ${whereClause}
    `;
    const speedAgg = await db.getAsync(speedSql, params);
    const totalRecs = speedAgg ? (speedAgg.city_count + speedAgg.mixed_count + speedAgg.highway_count) : 0;
    const styleDistribution = {
      city_pct: totalRecs > 0 ? Math.round((speedAgg.city_count / totalRecs) * 100) : 0,
      mixed_pct: totalRecs > 0 ? Math.round((speedAgg.mixed_count / totalRecs) * 100) : 0,
      highway_pct: totalRecs > 0 ? Math.round((speedAgg.highway_count / totalRecs) * 100) : 0,
      idle_minutes: speedAgg ? Math.round(speedAgg.idle_count / 60) : 0
    };

    // 4. Extremums & Records in Period
    const longestTrip = await db.getAsync(
      `SELECT id, distance_km, fuel_liters, start_time, max_speed FROM trips t WHERE ${whereClause} AND distance_km > 0 ORDER BY distance_km DESC LIMIT 1`,
      params
    );
    const fastestTrip = await db.getAsync(
      `SELECT id, distance_km, max_speed, avg_speed, start_time FROM trips t WHERE ${whereClause} AND max_speed > 0 ORDER BY max_speed DESC LIMIT 1`,
      params
    );
    const economicalTrip = await db.getAsync(
      `SELECT id, distance_km, fuel_liters, (fuel_liters / distance_km * 100) as l_per_100km, start_time FROM trips t WHERE ${whereClause} AND distance_km >= 2.0 AND fuel_liters > 0 ORDER BY l_per_100km ASC LIMIT 1`,
      params
    );

    res.json({
      period,
      fuel_price: fuelPrice,
      summary: {
        trips_count: agg ? agg.trips_count : 0,
        total_distance_km: totalDist,
        total_fuel_liters: totalFuel,
        total_cost_uah: totalCost,
        avg_consumption_l_100km: avgConsumption,
        max_speed: agg ? agg.max_speed : 0,
        avg_speed: agg ? agg.avg_speed : 0,
        total_duration_seconds: agg ? agg.total_duration_seconds : 0
      },
      daily,
      style_distribution: styleDistribution,
      records: {
        longest: longestTrip || null,
        fastest: fastestTrip || null,
        economical: economicalTrip ? { ...economicalTrip, l_per_100km: parseFloat(Number(economicalTrip.l_per_100km).toFixed(1)) } : null
      }
    });
  } catch (err) {
    console.error('[API /analytics] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 12.1 Detailed Trip Telemetry Series for Charts
router.get('/trips/:id/telemetry', async (req, res) => {
  const tripId = parseInt(req.params.id, 10);
  if (isNaN(tripId)) return res.status(400).json({ error: 'Invalid trip ID' });

  try {
    const records = await db.allAsync(
      `SELECT timestamp, speed, rpm, temp, voltage, fuel_rate, lat, lon FROM obd_records WHERE trip_id = ? ORDER BY id ASC`,
      [tripId]
    );

    if (!records || records.length === 0) {
      return res.json({ tripId, points: [] });
    }

    // Downsample if more than 300 points for silky smooth 60fps rendering
    let points = records;
    if (records.length > 300) {
      const step = Math.ceil(records.length / 300);
      points = records.filter((_, idx) => idx % step === 0 || idx === records.length - 1);
    }

    res.json({
      tripId,
      total_points: records.length,
      points: points.map(r => ({
        timestamp: r.timestamp,
        speed: r.speed || 0,
        rpm: r.rpm || 0,
        temp: r.temp || 0,
        voltage: r.voltage || 0,
        fuel_rate: r.fuel_rate || 0,
        has_gps: r.lat !== null && r.lon !== null
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 12.2 Export Analytics / Trips to CSV format
router.get('/analytics/export/csv', async (req, res) => {
  const { period = 'all', from, to } = req.query;

  try {
    const settingRow = await db.getAsync(`SELECT value FROM settings WHERE key = 'fuel_price'`);
    const fuelPrice = parseFloat(settingRow ? settingRow.value : '58.50') || 58.50;

    let whereClause = '1=1';
    const params = [];

    if (from && to) {
      whereClause = `DATE(t.start_time) >= DATE(?) AND DATE(t.start_time) <= DATE(?)`;
      params.push(from, to);
    } else if (from) {
      whereClause = `DATE(t.start_time) >= DATE(?)`;
      params.push(from);
    } else if (period === 'today') {
      whereClause = `DATE(t.start_time) >= DATE('now', 'localtime', 'start of day')`;
    } else if (period === 'week') {
      whereClause = `DATE(t.start_time) >= DATE('now', '-7 days')`;
    } else if (period === 'month') {
      whereClause = `DATE(t.start_time) >= DATE('now', '-30 days')`;
    } else if (period === 'year') {
      whereClause = `DATE(t.start_time) >= DATE('now', '-365 days')`;
    }

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
      WHERE ${whereClause}
      ORDER BY t.id DESC
    `;

    const rows = await db.allAsync(sql, params);

    // Build CSV with UTF-8 BOM for Microsoft Excel compatibility
    let csv = '\uFEFF';
    csv += 'ID;Початок поїздки;Завершення;Статус;Пробіг (км);Пальне (л);Вартість (грн);Сер. розхід (л/100км);Сер. швидкість (км/год);Макс. швидкість (км/год);Тривалість (хв)\r\n';

    for (const r of (rows || [])) {
      const dist = r.distance_km || 0;
      const fuel = r.fuel_liters || 0;
      const l100 = dist > 0 ? ((fuel / dist) * 100).toFixed(1) : '0.0';
      const cost = (fuel * fuelPrice).toFixed(2);
      const durationMin = Math.round((r.duration_seconds || 0) / 60);
      const statusLabel = r.status === 'active' ? 'Активна' : 'Завершена';

      csv += `${r.id};"${r.start_time || ''}";"${r.end_time || ''}";"${statusLabel}";${dist};${fuel};${cost};${l100};${r.avg_speed || 0};${r.max_speed || 0};${durationMin}\r\n`;
    }

    const dateStr = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="trips-analytics-${dateStr}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).send('Error generating CSV: ' + err.message);
  }
});

// =========================================================================
// 🛠️ SERVICE & MAINTENANCE API (Pajero 4 Car Service Book)
// =========================================================================

async function getCurrentOdometer() {
  const baseSetting = await db.getAsync("SELECT value FROM settings WHERE key = 'odometer_base'");
  const baseOdo = baseSetting ? (parseFloat(baseSetting.value) || 0) : 215000;
  const tripsSum = await db.getAsync("SELECT SUM(distance_km) as total_dist FROM trips");
  const totalTripsDist = (tripsSum && tripsSum.total_dist) ? parseFloat(tripsSum.total_dist) : 0;
  return Math.round((baseOdo + totalTripsDist) * 10) / 10;
}

// 1. Get all maintenance items with current health status & vehicle odometer
router.get('/service/items', async (req, res) => {
  try {
    const curOdo = await getCurrentOdometer();
    const rows = await db.allAsync("SELECT * FROM service_items ORDER BY id ASC");
    const now = new Date();

    const items = (rows || []).map(item => {
      const lastOdo = item.last_service_odometer || 0;
      const kmSince = Math.max(0, Math.round((curOdo - lastOdo) * 10) / 10);
      const kmRemaining = Math.round((item.interval_km - kmSince) * 10) / 10;
      const percentUsed = Math.min(100, Math.max(0, Math.round((kmSince / item.interval_km) * 100)));

      let monthsElapsed = 0;
      let monthsRemaining = item.interval_months || 12;
      if (item.last_service_date) {
        const lastDate = new Date(item.last_service_date);
        monthsElapsed = Math.max(0, (now.getFullYear() - lastDate.getFullYear()) * 12 + (now.getMonth() - lastDate.getMonth()));
        monthsRemaining = Math.max(0, (item.interval_months || 12) - monthsElapsed);
      }

      let status = 'ok';
      if (kmRemaining <= 0 || (item.interval_months && monthsRemaining <= 0)) {
        status = 'overdue';
      } else if (kmRemaining <= item.interval_km * 0.2 || (item.interval_months && monthsRemaining <= 1)) {
        status = 'warning';
      }

      return {
        ...item,
        current_odometer: curOdo,
        km_since_service: kmSince,
        km_remaining: kmRemaining,
        percent_used: percentUsed,
        months_elapsed: monthsElapsed,
        months_remaining: monthsRemaining,
        status
      };
    });

    res.json({
      success: true,
      current_odometer: curOdo,
      items
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Add custom maintenance item
router.post('/service/items', async (req, res) => {
  const { title, category = 'general', interval_km = 10000, interval_months = 12, last_service_odometer = 0, icon = '🔧', notes = '' } = req.body || {};
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Назва регламентної роботи обов\'язкова' });
  }

  try {
    const curOdo = await getCurrentOdometer();
    const lastOdo = last_service_odometer > 0 ? Number(last_service_odometer) : curOdo;
    const result = await db.runAsync(
      `INSERT INTO service_items (title, category, interval_km, interval_months, last_service_odometer, icon, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [title.trim(), category, Math.max(100, Number(interval_km) || 10000), Math.max(1, Number(interval_months) || 12), lastOdo, icon, notes || '']
    );
    res.json({ success: true, id: result.lastID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Update maintenance item
router.put('/service/items/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { title, category, interval_km, interval_months, last_service_odometer, icon, notes } = req.body || {};

  try {
    const item = await db.getAsync('SELECT * FROM service_items WHERE id = ?', [id]);
    if (!item) return res.status(404).json({ error: 'Пункт ТО не знайдено' });

    const newTitle = title ? title.trim() : item.title;
    const newCategory = category || item.category;
    const newIntervalKm = interval_km ? Math.max(100, Number(interval_km)) : item.interval_km;
    const newIntervalMonths = interval_months ? Math.max(1, Number(interval_months)) : item.interval_months;
    const newLastOdo = (last_service_odometer !== undefined && last_service_odometer !== null) ? Number(last_service_odometer) : item.last_service_odometer;
    const newIcon = icon || item.icon;
    const newNotes = notes !== undefined ? notes : item.notes;

    await db.runAsync(
      `UPDATE service_items SET title = ?, category = ?, interval_km = ?, interval_months = ?, last_service_odometer = ?, icon = ?, notes = ? WHERE id = ?`,
      [newTitle, newCategory, newIntervalKm, newIntervalMonths, newLastOdo, newIcon, newNotes, id]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Delete maintenance item
router.delete('/service/items/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    await db.runAsync('DELETE FROM service_items WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Mark Service Complete / Replace
router.post('/service/items/:id/replace', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { cost = 0, date = null, notes = '', odometer = null } = req.body || {};

  try {
    const item = await db.getAsync('SELECT * FROM service_items WHERE id = ?', [id]);
    if (!item) return res.status(404).json({ error: 'Пункт ТО не знайдено' });

    const curOdo = await getCurrentOdometer();
    const serviceOdo = (odometer !== null && odometer !== undefined && Number(odometer) > 0) ? Number(odometer) : curOdo;
    const serviceDate = date ? new Date(date).toISOString() : new Date().toISOString();
    const serviceCost = Math.max(0, Number(cost) || 0);

    await db.runAsync(
      `UPDATE service_items SET last_service_odometer = ?, last_service_date = ? WHERE id = ?`,
      [serviceOdo, serviceDate, id]
    );

    await db.runAsync(
      `INSERT INTO service_logs (item_id, title, odometer, cost, date, notes) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, item.title, serviceOdo, serviceCost, serviceDate, notes || '']
    );

    res.json({ success: true, message: 'Заміну успішно зафіксовано в сервісній книжці' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Service logs history
router.get('/service/logs', async (req, res) => {
  try {
    const rows = await db.allAsync('SELECT * FROM service_logs ORDER BY date DESC, id DESC');
    res.json({ success: true, logs: rows || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Get/Set Base Odometer
router.get('/service/odometer', async (req, res) => {
  try {
    const baseSetting = await db.getAsync("SELECT value FROM settings WHERE key = 'odometer_base'");
    const baseOdo = baseSetting ? (parseFloat(baseSetting.value) || 0) : 215000;
    const tripsSum = await db.getAsync("SELECT SUM(distance_km) as total_dist FROM trips");
    const totalTripsDist = (tripsSum && tripsSum.total_dist) ? parseFloat(tripsSum.total_dist) : 0;
    const curOdo = Math.round((baseOdo + totalTripsDist) * 10) / 10;

    res.json({
      success: true,
      current_odometer: curOdo,
      base_odometer: baseOdo,
      trips_distance: Math.round(totalTripsDist * 10) / 10
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/service/odometer', async (req, res) => {
  const { odometer_base } = req.body || {};
  const newBase = Math.max(0, Number(odometer_base) || 0);

  try {
    await db.runAsync("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('odometer_base', ?, CURRENT_TIMESTAMP)", [String(newBase)]);
    const curOdo = await getCurrentOdometer();
    res.json({ success: true, current_odometer: curOdo, base_odometer: newBase });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// 📊 REPORTS & SUMMARY EXPORT API
// =========================================================================

router.get('/reports/summary', async (req, res) => {
  try {
    const { period = 'all' } = req.query;
    let whereClause = '1=1';

    if (period === 'today') {
      whereClause = `DATE(start_time) >= DATE('now', 'localtime', 'start of day')`;
    } else if (period === 'week') {
      whereClause = `DATE(start_time) >= DATE('now', '-7 days')`;
    } else if (period === 'month') {
      whereClause = `DATE(start_time) >= DATE('now', '-30 days')`;
    } else if (period === 'year') {
      whereClause = `DATE(start_time) >= DATE('now', '-365 days')`;
    }

    const fuelPriceSetting = await db.getAsync("SELECT value FROM settings WHERE key = 'fuel_price'");
    const fuelPrice = fuelPriceSetting ? (parseFloat(fuelPriceSetting.value) || 58.50) : 58.50;

    const stats = await db.getAsync(`
      SELECT 
        COUNT(*) as total_trips,
        COALESCE(SUM(distance_km), 0) as total_distance_km,
        COALESCE(SUM(fuel_liters), 0) as total_fuel_liters,
        COALESCE(AVG(NULLIF(avg_speed, 0)), 0) as avg_speed,
        COALESCE(MAX(max_speed), 0) as max_speed,
        COALESCE(MAX(distance_km), 0) as longest_trip_km
      FROM trips
      WHERE ${whereClause}
    `);

    const dist = Math.round((stats.total_distance_km || 0) * 10) / 10;
    const fuel = Math.round((stats.total_fuel_liters || 0) * 10) / 10;
    const cost = Math.round(fuel * fuelPrice);
    const avgL100 = dist > 0 ? Math.round((fuel / dist) * 1000) / 10 : 0;
    const costPerKm = dist > 0 ? Math.round((cost / dist) * 100) / 100 : 0;

    res.json({
      success: true,
      period,
      fuel_price: fuelPrice,
      total_trips: stats.total_trips || 0,
      total_distance_km: dist,
      total_fuel_liters: fuel,
      total_cost_uah: cost,
      avg_consumption_l100km: avgL100,
      avg_speed_kmh: Math.round(stats.avg_speed || 0),
      max_speed_kmh: Math.round(stats.max_speed || 0),
      longest_trip_km: Math.round((stats.longest_trip_km || 0) * 10) / 10,
      cost_per_km_uah: costPerKm
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/reports/telegram-summary', async (req, res) => {
  const { period = 'month' } = req.body || {};
  try {
    const fuelPriceSetting = await db.getAsync("SELECT value FROM settings WHERE key = 'fuel_price'");
    const fuelPrice = fuelPriceSetting ? (parseFloat(fuelPriceSetting.value) || 58.50) : 58.50;

    let whereClause = '1=1';
    let periodName = 'за весь час';
    if (period === 'month') {
      whereClause = `DATE(start_time) >= DATE('now', '-30 days')`;
      periodName = 'за останні 30 днів';
    } else if (period === 'week') {
      whereClause = `DATE(start_time) >= DATE('now', '-7 days')`;
      periodName = 'за останні 7 днів';
    }

    const stats = await db.getAsync(`
      SELECT COUNT(*) as count,
             COALESCE(SUM(distance_km), 0) as dist,
             COALESCE(SUM(fuel_liters), 0) as fuel,
             COALESCE(AVG(NULLIF(avg_speed, 0)), 0) as speed
      FROM trips
      WHERE ${whereClause}
    `);

    const dist = Math.round((stats.dist || 0) * 10) / 10;
    const fuel = Math.round((stats.fuel || 0) * 10) / 10;
    const cost = Math.round(fuel * fuelPrice);
    const l100 = dist > 0 ? ((fuel / dist) * 100).toFixed(1) : '0.0';
    const costPerKm = dist > 0 ? (cost / dist).toFixed(2) : '0.00';

    res.json({
      success: true,
      message: `Звіт сформовано: ${dist} км, ${fuel} л, ${cost} грн (${periodName})`
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
