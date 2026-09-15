const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

// Configure test environment (in-memory SQLite DB)
process.env.DB_PATH = ':memory:';
process.env.PORT = '0';

const db = require('../src/db');
const apiRoutes = require('../src/routes/api');
const tripService = require('../src/services/tripService');

const app = express();
app.use(express.json());
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
        'User-Agent': 'ESP32-OBD2-TestClient'
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
});

test('ANALYTICS 1: Period aggregation & KPI summaries calculation', async () => {
  await request('POST', '/api/reset-data');

  // Insert mock trips into DB
  await db.runAsync(
    `INSERT INTO trips (id, status, start_time, end_time, distance_km, fuel_liters, avg_speed, max_speed)
     VALUES (1, 'finished', datetime('now', '-2 days'), datetime('now', '-2 days', '+30 minutes'), 25.0, 3.2, 50.0, 95.0)`
  );
  await db.runAsync(
    `INSERT INTO trips (id, status, start_time, end_time, distance_km, fuel_liters, avg_speed, max_speed)
     VALUES (2, 'finished', datetime('now', '-1 days'), datetime('now', '-1 days', '+45 minutes'), 40.0, 4.8, 55.0, 110.0)`
  );

  // Insert some records to test speed distribution
  await db.runAsync(`INSERT INTO obd_records (trip_id, speed, rpm, temp, voltage, fuel_rate) VALUES (1, 40, 1500, 88, 14.1, 4.5)`);
  await db.runAsync(`INSERT INTO obd_records (trip_id, speed, rpm, temp, voltage, fuel_rate) VALUES (1, 70, 2200, 90, 14.2, 7.8)`);
  await db.runAsync(`INSERT INTO obd_records (trip_id, speed, rpm, temp, voltage, fuel_rate) VALUES (2, 95, 2600, 92, 14.0, 9.2)`);
  await db.runAsync(`INSERT INTO obd_records (trip_id, speed, rpm, temp, voltage, fuel_rate) VALUES (2, 0, 700, 89, 14.1, 1.2)`); // Idle

  const res = await request('GET', '/api/analytics?period=month');
  assert.equal(res.status, 200);
  assert.equal(res.body.summary.trips_count, 2);
  assert.equal(res.body.summary.total_distance_km, 65.0);
  assert.equal(res.body.summary.total_fuel_liters, 8.0);
  assert.equal(res.body.summary.max_speed, 110.0);
  assert.ok(res.body.summary.total_cost_uah > 0);
  assert.ok(res.body.summary.avg_consumption_l_100km > 0);

  // Style distribution
  assert.ok(res.body.style_distribution.city_pct >= 0);
  assert.ok(res.body.style_distribution.highway_pct >= 0);

  // Daily breakdown
  assert.equal(res.body.daily.length, 2);

  // Records
  assert.equal(res.body.records.longest.id, 2);
  assert.equal(res.body.records.fastest.id, 2);
});

test('ANALYTICS 2: Detailed trip telemetry series for charts', async () => {
  const res = await request('GET', '/api/trips/1/telemetry');
  assert.equal(res.status, 200);
  assert.equal(res.body.tripId, 1);
  assert.equal(res.body.points.length, 2);
  assert.equal(res.body.points[0].speed, 40);
  assert.equal(res.body.points[0].rpm, 1500);
  assert.equal(res.body.points[1].speed, 70);
});

test('ANALYTICS 3: CSV Export format & headers validation', async () => {
  const res = await request('GET', '/api/analytics/export/csv?period=month');
  assert.equal(res.status, 200);
  assert.ok(res.headers['content-type'].includes('text/csv'));
  assert.ok(res.headers['content-disposition'].includes('trips-analytics'));

  const csvContent = res.body;
  assert.ok(csvContent.startsWith('\uFEFF')); // UTF-8 BOM
  assert.ok(csvContent.includes('ID;Початок поїздки;Завершення;Статус;Пробіг (км);Пальне (л);Вартість (грн)'));
  assert.ok(csvContent.includes('25;3.2;'));
  assert.ok(csvContent.includes('40;4.8;'));
});

test('ANALYTICS 4: Empty state handling when no trips exist', async () => {
  await request('POST', '/api/reset-data');

  const res = await request('GET', '/api/analytics?period=month');
  assert.equal(res.status, 200);
  assert.equal(res.body.summary.trips_count, 0);
  assert.equal(res.body.summary.total_distance_km, 0);
  assert.equal(res.body.summary.total_fuel_liters, 0);
  assert.equal(res.body.summary.total_cost_uah, 0);
  assert.equal(res.body.daily.length, 0);
  assert.equal(res.body.records.longest, null);
});
