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
        'User-Agent': 'ESP32-OBD2-EdgeTestClient',
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
// 🧪 COMPREHENSIVE EDGE-CASE & STRESS TEST SUITE
// =========================================================================

test('EDGE 1: Invalid & Corrupt Payload Sanitization (NaN, Strings, Negative Values)', async () => {
  const corruptPayload = {
    rpm: 'INVALID_RPM',
    speed: -50, // Negative speed must be clamped to 0
    temp: 'NaN',
    voltage: null,
    fuel_rate: -10
  };

  const res = await request('POST', '/api/obd', corruptPayload);
  assert.equal(res.status, 201);
  assert.equal(res.body.success, true);

  // Check saved record in DB
  const dataRes = await request('GET', '/api/data');
  assert.equal(dataRes.body.latest.rpm, 0);
  assert.equal(dataRes.body.latest.speed, 0);
  assert.equal(dataRes.body.latest.voltage, 0);
  assert.equal(dataRes.body.latest.fuel_rate, 0);
});

test('EDGE 2: Empty, Malformed, or Non-Array Batch Ingestion', async () => {
  const res1 = await request('POST', '/api/obd/batch', {});
  assert.equal(res1.status, 400);

  const res2 = await request('POST', '/api/obd/batch', { records: [] });
  assert.equal(res2.status, 400);

  const res3 = await request('POST', '/api/obd/batch', { records: 'NOT_AN_ARRAY' });
  assert.equal(res3.status, 400);
});

test('EDGE 3: Zero-Distance Micro-Trip Calculation (No Division by Zero / Infinity)', async () => {
  // Ingest stationary idling points
  for (let i = 0; i < 5; i++) {
    await request('POST', '/api/obd', { rpm: 750, speed: 0, temp: 85, voltage: 14.1, fuel_rate: 1.2 });
  }

  const tripsRes = await request('GET', '/api/trips');
  assert.equal(tripsRes.status, 200);
  assert.ok(tripsRes.body.length > 0);

  const currentTrip = tripsRes.body[0];
  assert.equal(currentTrip.distance_km, 0);
  assert.equal(currentTrip.avg_speed, 0);
  assert.equal(currentTrip.l_per_100km, 0); // Must be clean 0, not Infinity or NaN
  assert.ok(isFinite(currentTrip.trip_cost_uah));
});

test('EDGE 4: Guaranteed Dashes/Zeroes When Device Is Offline', async () => {
  // Purge logs and status to emulate fresh uncontacted state
  await request('DELETE', '/api/device/logs');

  const statusRes = await request('GET', '/api/device/status');
  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.body.status.ip, '--');
  assert.equal(statusRes.body.status.rssi, null);
  assert.equal(statusRes.body.status.bt, 'disconnected');
  assert.equal(statusRes.body.status.free_heap, '--');
  assert.equal(statusRes.body.is_online, false);
});

test('EDGE 5: Massive 500-Record Batch Ingestion Stress Test', async () => {
  const massiveRecords = [];
  for (let i = 0; i < 500; i++) {
    massiveRecords.push({
      rpm: 1500 + (i % 200) * 10,
      speed: 40 + (i % 60),
      temp: 88 + (i % 5),
      voltage: 14.2,
      fuel_rate: 6.5,
      dt: 1.0
    });
  }

  const batchRes = await request('POST', '/api/obd/batch', { records: massiveRecords });
  assert.equal(batchRes.status, 201);
  assert.equal(batchRes.body.count, 500);

  const tripsRes = await request('GET', '/api/trips');
  const activeTrip = tripsRes.body.find(t => t.status === 'active');
  assert.ok(activeTrip);
  assert.ok(activeTrip.distance_km > 5.0);
  assert.ok(activeTrip.max_speed >= 95);
});

test('EDGE 6: Concurrent Parallel Requests (No SQLite Locks)', async () => {
  const promises = [];
  for (let i = 0; i < 20; i++) {
    promises.push(request('POST', '/api/obd', { rpm: 2000, speed: 60, temp: 90, voltage: 14.2, fuel_rate: 7.0 }));
  }

  const results = await Promise.all(promises);
  for (const res of results) {
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
  }
});

test('EDGE 7: Purge All Data & Clean State Re-Verification', async () => {
  const resetRes = await request('POST', '/api/reset-data');
  assert.equal(resetRes.status, 200);
  assert.equal(resetRes.body.success, true);

  const tripsRes = await request('GET', '/api/trips');
  assert.equal(tripsRes.body.length, 0);

  const historyRes = await request('GET', '/api/history');
  assert.equal(historyRes.body.length, 0);

  const dataRes = await request('GET', '/api/data');
  assert.equal(dataRes.body.latest.rpm, 0);
  assert.equal(dataRes.body.latest.speed, 0);
  assert.equal(dataRes.body.trip.distance_km, 0);
});
