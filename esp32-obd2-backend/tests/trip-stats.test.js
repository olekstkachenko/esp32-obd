const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.DB_PATH = ':memory:';
process.env.PORT = '0';

const db = require('../src/db');
const apiRoutes = require('../src/routes/api');
const tripService = require('../src/services/tripService');

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
        'User-Agent': 'ESP32-OBD2-TripStatsTest',
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
// 📊 TRIP STATS, FIRST-RECORD SPEED & SETTINGS TESTS
// =========================================================================

test('STATS 1: First record preserves max_speed and avg_speed properly', async () => {
  // Purge previous state
  await request('POST', '/api/reset-data');

  // Very first record of a new trip with speed 85 km/h
  const res = await request('POST', '/api/obd', { rpm: 2500, speed: 85, temp: 88, voltage: 14.2, fuel_rate: 7.5 });
  assert.equal(res.status, 201);
  const tripId = res.body.tripId;

  const tripRes = await request('GET', `/api/trips/${tripId}`);
  assert.equal(tripRes.status, 200);
  assert.equal(tripRes.body.trip.max_speed, 85);
});

test('STATS 2: Settings validation (Rejects negative, 0, >200, string junk)', async () => {
  const invalid1 = await request('POST', '/api/settings', { fuel_price: -15 });
  assert.equal(invalid1.status, 400);

  const invalid2 = await request('POST', '/api/settings', { fuel_price: 0 });
  assert.equal(invalid2.status, 400);

  const invalid3 = await request('POST', '/api/settings', { fuel_price: 9999 });
  assert.equal(invalid3.status, 400);

  const invalid4 = await request('POST', '/api/settings', { fuel_price: 'INVALID' });
  assert.equal(invalid4.status, 400);

  // Valid price
  const valid = await request('POST', '/api/settings', { fuel_price: 59.90 });
  assert.equal(valid.status, 200);
  assert.equal(valid.body.fuel_price, '59.90');

  const settingsRes = await request('GET', '/api/settings');
  assert.equal(settingsRes.body.fuel_price, '59.90');
});

test('STATS 3: Custom fuel price calculation across trips archive', async () => {
  // Ingest batch with explicit dt (e.g. 10 points * 10 seconds = 100 seconds)
  const batchRecords = [];
  for (let i = 0; i < 10; i++) {
    batchRecords.push({ rpm: 2000, speed: 60, temp: 89, voltage: 14.2, fuel_rate: 6.0, dt: 10.0 });
  }

  const batchRes = await request('POST', '/api/obd/batch', { records: batchRecords });
  assert.equal(batchRes.status, 201);

  const trips = await request('GET', '/api/trips');
  assert.ok(trips.body.length > 0);
  const trip = trips.body[0];
  assert.ok(trip.fuel_liters > 0);
  assert.ok(trip.trip_cost_uah > 0);
  // Cost should reflect fuel_liters * 59.90
  const expectedCost = parseFloat((trip.fuel_liters * 59.90).toFixed(2));
  assert.equal(trip.trip_cost_uah, expectedCost);
});
