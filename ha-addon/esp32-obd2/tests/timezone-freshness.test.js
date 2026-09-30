const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

// Configure test environment (in-memory SQLite DB)
process.env.DB_PATH = ':memory:';
process.env.PORT = '0';

const db = require('../src/db');
const apiRoutes = require('../src/routes/api');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});
app.use('/api', apiRoutes);

let server;
let baseUrl;

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'ESP32-OBD2-TimezoneTest',
        'ngrok-skip-browser-warning': 'true'
      }
    };

    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body: json || data });
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => db.close(resolve));
});

// =========================================================================
// 🕒 TIMEZONE & FRESHNESS STALE-DATA PROTECTION TESTS
// =========================================================================

test('TIMEZONE 1: Fresh live record generated just now is detected as live (not stale)', async () => {
  // Ingest a live point
  const record = { rpm: 2100, speed: 55, temp: 88, voltage: 14.1, fuel_rate: 6.5 };
  const res = await request('POST', '/api/obd', record);
  assert.equal(res.status, 201);

  // Send device heartbeat
  await request('POST', '/api/device/log', {
    message: 'Live ping',
    wifi_status: 'connected',
    bt_status: 'connected',
    free_heap: 120,
    rssi: -50,
    ip: '192.168.43.10'
  });

  const dataRes = await request('GET', '/api/data');
  assert.equal(dataRes.status, 200);
  assert.equal(dataRes.body.is_online, true);
  assert.equal(dataRes.body.is_stale, false);
  assert.equal(dataRes.body.latest.speed, 55);
  assert.equal(dataRes.body.latest.rpm, 2100);
});

test('TIMEZONE 2: Record generated with SQLite UTC timestamp format is parsed accurately', async () => {
  await request('POST', '/api/reset-data');
  await db.runAsync(`INSERT INTO trips (id, status) VALUES (1, 'active')`);
  // Directly insert a record with SQLite standard format 'YYYY-MM-DD HH:MM:SS'
  const utcNow = new Date().toISOString().replace('T', ' ').substring(0, 19);
  await db.runAsync(
    `INSERT INTO obd_records (trip_id, timestamp, rpm, speed, temp, voltage, fuel_rate) 
     VALUES (1, ?, 3000, 80, 90, 14.2, 8.0)`,
    [utcNow]
  );

  const dataRes = await request('GET', '/api/data');
  assert.equal(dataRes.status, 200);
  assert.equal(dataRes.body.is_stale, false);
  assert.equal(dataRes.body.latest.speed, 80);
});

test('TIMEZONE 3: Expired record older than 25 seconds is zeroed out on UI', async () => {
  await request('POST', '/api/reset-data');
  await db.runAsync(`INSERT INTO trips (id, status) VALUES (1, 'active')`);
  // Insert an old record (1 hour ago)
  const oneHourAgo = new Date(Date.now() - 3600000).toISOString().replace('T', ' ').substring(0, 19);
  await db.runAsync(
    `INSERT INTO obd_records (trip_id, timestamp, rpm, speed, temp, voltage, fuel_rate) 
     VALUES (1, ?, 4500, 120, 95, 14.4, 12.0)`,
    [oneHourAgo]
  );

  // Clear device log last_seen to emulate offline
  await request('DELETE', '/api/device/logs');

  const dataRes = await request('GET', '/api/data');
  assert.equal(dataRes.status, 200);
  assert.equal(dataRes.body.is_online, false);
  assert.equal(dataRes.body.is_stale, true);
  // Live values must be sanitized to 0
  assert.equal(dataRes.body.latest.speed, 0);
  assert.equal(dataRes.body.latest.rpm, 0);
  assert.equal(dataRes.body.latest.temp, 0);
  assert.equal(dataRes.body.latest.voltage, 0);
  assert.equal(dataRes.body.latest.fuel_rate, 0);
});
