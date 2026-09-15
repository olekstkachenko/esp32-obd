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
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

let server;
let baseUrl;

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'ESP32-OBD2-Pajero4-Sim',
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
// 🚗 VEHICLE SCENARIO SIMULATION TESTS (Mitsubishi Pajero 4 + Blue ELM327)
// =========================================================================

test('SCENARIO 1: Android Headunit 15s Boot Delay & Offline Batch Catch-up', async () => {
  // 1. ESP32 boots instantly (0.3s) and logs startup event
  const bootLog = await request('POST', '/api/device/log', {
    message: '🚀 ESP32 успішно завантажено! Очікування старту Android точки доступу та сканера...',
    level: 'info',
    wifi_status: 'connecting',
    free_heap: 120,
    rssi: 0,
    ip: '0.0.0.0'
  });
  assert.equal(bootLog.status, 200);

  // 2. Android hotspot was off for 15 seconds. ESP32 collected 15 records in RAM buffer.
  const bufferedRecordsDuringBoot = [];
  for (let s = 1; s <= 15; s++) {
    bufferedRecordsDuringBoot.push({
      rpm: 720,
      speed: 0,
      temp: 45 + s,
      voltage: 14.1,
      fuel_rate: 1.8,
      dt: 1.0
    });
  }

  // 3. Android Wi-Fi comes online -> ESP32 flushes batch of 15 records
  const batchRes = await request('POST', '/api/obd/batch', { records: bufferedRecordsDuringBoot });
  assert.equal(batchRes.status, 201);
  assert.equal(batchRes.body.success, true);
  assert.equal(batchRes.body.count, 15);
  assert.ok(batchRes.body.tripId);

  // 4. Verify trip was created and records stored
  const tripRes = await request('GET', `/api/trips/${batchRes.body.tripId}`);
  assert.equal(tripRes.status, 200);
  assert.equal(tripRes.body.records.length, 15);
});

test('SCENARIO 2: Engine OFF / Idle with Blue ELM327 Constant 12V Battery Power', async () => {
  // In Pajero 4, OBD pin 16 is constantly powered (12.3V battery, 0 RPM)
  const idleRecord = {
    rpm: 0,
    speed: 0,
    temp: 35,
    voltage: 12.3,
    fuel_rate: 0
  };

  const res = await request('POST', '/api/obd', idleRecord);
  assert.equal(res.status, 201);

  // Send diagnostic log from ESP32 confirming engine is sleeping
  const logRes = await request('POST', '/api/device/log', {
    message: '💤 Запалювання вимкнено (очікування старту двигуна Pajero 4)...',
    level: 'info',
    bt_status: 'engine_off',
    wifi_status: 'connected',
    free_heap: 118,
    rssi: -52,
    ip: '192.168.43.50'
  });
  assert.equal(logRes.status, 200);

  // Device status reflects engine state
  const statusRes = await request('GET', '/api/device/status');
  assert.equal(statusRes.body.status.bt, 'engine_off');
});

test('SCENARIO 3: Dynamic City & Highway Driving (Pajero 4 Gasoline Run)', async () => {
  // Simulate acceleration: 0 -> 40 -> 60 -> 90 -> 110 km/h -> decelerate
  const drivingSpeeds = [10, 25, 40, 55, 65, 80, 95, 110, 105, 90, 70, 45, 20, 0];
  const tripRecords = drivingSpeeds.map((spd) => ({
    rpm: spd > 0 ? (1200 + spd * 25) : 700,
    speed: spd,
    temp: 88,
    voltage: 14.2,
    fuel_rate: spd > 0 ? (3.5 + spd * 0.08) : 1.4,
    dt: 2.0
  }));

  const batchRes = await request('POST', '/api/obd/batch', { records: tripRecords });
  assert.equal(batchRes.status, 201);
  assert.equal(batchRes.body.count, drivingSpeeds.length);

  // Verify trip metrics
  const tripsRes = await request('GET', '/api/trips');
  const activeTrip = tripsRes.body.find(t => t.status === 'active');
  assert.ok(activeTrip);
  assert.ok(activeTrip.distance_km > 0.4);
  assert.equal(activeTrip.max_speed, 110.0);
  assert.ok(activeTrip.avg_speed > 30);
  assert.ok(activeTrip.fuel_liters > 0);
  assert.ok(activeTrip.trip_cost_uah > 0);
});

test('SCENARIO 4: 4G Cellular Tunnel Dropout & Auto-Recovery (45s buffer)', async () => {
  // Simulates driving through underground tunnel / dead zone for 45 seconds
  const tunnelRecords = [];
  for (let i = 0; i < 45; i++) {
    tunnelRecords.push({
      rpm: 2100,
      speed: 75.0,
      temp: 90,
      voltage: 14.2,
      fuel_rate: 8.5,
      dt: 1.0
    });
  }

  // When car exits tunnel, ESP32 reconnects and dumps the full 45s buffer
  const syncRes = await request('POST', '/api/obd/batch', { records: tunnelRecords });
  assert.equal(syncRes.status, 201);
  assert.equal(syncRes.body.count, 45);

  // Distance should increase smoothly
  const tripsRes = await request('GET', '/api/trips');
  const activeTrip = tripsRes.body.find(t => t.status === 'active');
  assert.ok(activeTrip.distance_km > 1.2);
});

test('SCENARIO 5: Starter Cranking Reboot / Brownout Session Continuity', async () => {
  // ESP32 resets due to starter crank voltage drop, then comes back 3 seconds later
  const postRebootRecord = {
    rpm: 1800,
    speed: 50.0,
    temp: 89,
    voltage: 14.3,
    fuel_rate: 6.2
  };

  const res = await request('POST', '/api/obd', postRebootRecord);
  assert.equal(res.status, 201);

  // Must still be the SAME active trip, not fragmented into multiple trips
  const tripsRes = await request('GET', '/api/trips');
  const activeTrips = tripsRes.body.filter(t => t.status === 'active');
  assert.equal(activeTrips.length, 1);
});

test('SCENARIO 6: Manual Trip Finish & Fuel Expense Calculation', async () => {
  // Set Pajero fuel price (e.g. 58.50 UAH/L)
  await request('POST', '/api/settings', { fuel_price: 58.50 });

  const finishRes = await request('POST', '/api/trips/finish');
  assert.equal(finishRes.status, 200);
  assert.ok(finishRes.body.finishedId);

  // Check finished trip in archive
  const tripsRes = await request('GET', '/api/trips');
  const completedTrip = tripsRes.body.find(t => t.id === finishRes.body.finishedId);
  assert.ok(completedTrip);
  assert.equal(completedTrip.status, 'completed');
  assert.ok(completedTrip.distance_km > 1.0);
  assert.ok(completedTrip.fuel_liters > 0);
  assert.ok(completedTrip.trip_cost_uah > 0);
  assert.ok(completedTrip.l_per_100km > 0);
});

test('SCENARIO 7: Diagnostics Event Stream & Log Auto-Pruning', async () => {
  // Log various ELM327 events
  await request('POST', '/api/device/log', { message: '📡 Пошук протоколу CAN ISO 15765-4...', level: 'info' });
  await request('POST', '/api/device/log', { message: '🚀 Протокол звʼязано з ЕБУ Pajero 4!', level: 'success', bt_status: 'connected' });
  await request('POST', '/api/device/log', { message: '⚠️ Тимчасовий таймаут відповіді PID', level: 'warn' });

  const statusRes = await request('GET', '/api/device/status');
  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.body.status.bt, 'connected');
  assert.ok(statusRes.body.logs.length >= 3);
  assert.ok(statusRes.body.logs.some(l => l.level === 'warn'));
  assert.ok(statusRes.body.logs.some(l => l.level === 'success'));
});
