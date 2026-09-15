const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

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
        'User-Agent': 'ESP32-OBD2-ChunkedTest',
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
// 📦 CHUNKED BATCH SYNC & BUFFER PROCESSING TESTS
// =========================================================================

test('CHUNK 1: Sequential 40-record chunking simulation (120 total records)', async () => {
  const CHUNK_SIZE = 40;
  const TOTAL_RECORDS = 120;
  const allRecords = [];

  for (let i = 0; i < TOTAL_RECORDS; i++) {
    allRecords.push({
      rpm: 1500 + (i % 50) * 20,
      speed: 30 + (i % 60),
      temp: 85 + (i % 10),
      voltage: 14.1,
      fuel_rate: 5.5,
      dt: 1.0
    });
  }

  // Simulate ESP32 sending in 3 chunks of 40 records
  let sentCount = 0;
  while (sentCount < allRecords.length) {
    const chunk = allRecords.slice(sentCount, sentCount + CHUNK_SIZE);
    const res = await request('POST', '/api/obd/batch', { records: chunk });
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.count, chunk.length);
    sentCount += chunk.length;
  }

  assert.equal(sentCount, TOTAL_RECORDS);

  // Check total records inserted in DB
  const history = await db.allAsync(`SELECT COUNT(*) as count FROM obd_records`);
  assert.equal(history[0].count, TOTAL_RECORDS);

  // Check trip stats accumulation
  const trips = await request('GET', '/api/trips');
  const activeTrip = trips.body.find(t => t.status === 'active');
  assert.ok(activeTrip);
  assert.ok(activeTrip.distance_km > 1.5);
  assert.ok(activeTrip.fuel_liters > 0);
});

test('CHUNK 2: Extreme dt bounds protection in batch records (0s, 9999s, negative dt)', async () => {
  const boundaryBatch = [
    { rpm: 2000, speed: 60, temp: 90, voltage: 14.2, fuel_rate: 6.0, dt: 0 }, // 0 dt -> fallback to 1.0s
    { rpm: 2000, speed: 60, temp: 90, voltage: 14.2, fuel_rate: 6.0, dt: -5 }, // negative -> fallback to 1.0s
    { rpm: 2000, speed: 60, temp: 90, voltage: 14.2, fuel_rate: 6.0, dt: 99999 }, // > 60s -> fallback to 1.0s
    { rpm: 2000, speed: 60, temp: 90, voltage: 14.2, fuel_rate: 6.0, dt: 2.5 } // valid
  ];

  const res = await request('POST', '/api/obd/batch', { records: boundaryBatch });
  assert.equal(res.status, 201);
  assert.equal(res.body.count, 4);
});
