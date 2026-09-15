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

test('GPS 1: Single OBD record with GPS coordinates ingestion', async () => {
  await request('POST', '/api/reset-data');

  const res = await request('POST', '/api/obd', {
    rpm: 2100,
    speed: 65,
    temp: 88,
    voltage: 14.1,
    fuel_rate: 8.5,
    lat: 50.4501,
    lon: 30.5234,
    alt: 142.5,
    sat: 8
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.success, true);
  const tripId = res.body.tripId;

  // Retrieve trip details
  const tripRes = await request('GET', `/api/trips/${tripId}`);
  assert.equal(tripRes.status, 200);
  assert.equal(tripRes.body.trip.has_gps, true);
  assert.equal(tripRes.body.records.length, 1);
  assert.equal(tripRes.body.records[0].lat, 50.4501);
  assert.equal(tripRes.body.records[0].lon, 30.5234);
  assert.equal(tripRes.body.records[0].alt, 142.5);
  assert.equal(tripRes.body.records[0].sat, 8);
});

test('GPS 2: Batch OBD records with route tracking points', async () => {
  const batchPayload = {
    records: [
      { rpm: 1500, speed: 40, temp: 88, voltage: 14.2, fuel_rate: 6.0, dt: 2.0, lat: 50.4510, lon: 30.5240, alt: 143, sat: 9 },
      { rpm: 2200, speed: 70, temp: 89, voltage: 14.2, fuel_rate: 9.0, dt: 2.0, lat: 50.4530, lon: 30.5270, alt: 145, sat: 9 },
      { rpm: 2400, speed: 80, temp: 90, voltage: 14.2, fuel_rate: 10.5, dt: 2.0, lat: 50.4560, lon: 30.5310, alt: 148, sat: 10 }
    ]
  };

  const res = await request('POST', '/api/obd/batch', batchPayload);
  assert.equal(res.status, 201);
  assert.equal(res.body.count, 3);
  const tripId = res.body.tripId;

  const tripRes = await request('GET', `/api/trips/${tripId}`);
  assert.equal(tripRes.status, 200);
  assert.equal(tripRes.body.trip.has_gps, true);
  assert.equal(tripRes.body.records.length, 4); // 1 from test 1 + 3 from batch
});

test('GPS 3: Export Trip to GPX 1.1 format', async () => {
  const currentTripId = tripService.getCurrentTripId();
  const gpxRes = await request('GET', `/api/trips/${currentTripId}/gpx`);

  assert.equal(gpxRes.status, 200);
  assert.ok(gpxRes.headers['content-type'].includes('application/gpx+xml'));
  assert.ok(typeof gpxRes.body === 'string');
  assert.ok(gpxRes.body.includes('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(gpxRes.body.includes('<gpx version="1.1"'));
  assert.ok(gpxRes.body.includes('lat="50.4501" lon="30.5234"'));
  assert.ok(gpxRes.body.includes('lat="50.456" lon="30.531"'));
  assert.ok(gpxRes.body.includes('<trkpt'));
});

test('GPS 4: Graceful handling of trips without GPS points', async () => {
  await request('POST', '/api/reset-data');

  // Add record without GPS (e.g. module not connected)
  const res = await request('POST', '/api/obd', {
    rpm: 800,
    speed: 0,
    temp: 70,
    voltage: 12.6,
    fuel_rate: 1.2
  });

  const tripId = res.body.tripId;
  const tripRes = await request('GET', `/api/trips/${tripId}`);
  assert.equal(tripRes.status, 200);
  assert.equal(tripRes.body.trip.has_gps, false);
  assert.equal(tripRes.body.records[0].lat, null);
  assert.equal(tripRes.body.records[0].lon, null);

  // GPX should return 404 when no GPS points exist
  const gpxRes = await request('GET', `/api/trips/${tripId}/gpx`);
  assert.equal(gpxRes.status, 404);
});
