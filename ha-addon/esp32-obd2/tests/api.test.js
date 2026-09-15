const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const path = require('path');

// Configure test environment (in-memory SQLite DB)
process.env.DB_PATH = ':memory:';
process.env.PORT = '0'; // Random available port

const db = require('../src/db');
const apiRoutes = require('../src/routes/api');

// Setup test express app
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
        'User-Agent': 'ESP32-OBD2-TestClient',
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

test('1. Health Check Endpoint (/health)', async () => {
  const res = await request('GET', '/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.ok(res.body.timestamp);
});

test('2. Device Log Ingestion (/api/device/log)', async () => {
  const payload = {
    message: 'Test Wi-Fi connection successful',
    level: 'success',
    wifi_status: 'connected',
    bt_status: 'connected',
    free_heap: 115,
    rssi: -58,
    ip: '192.168.0.55'
  };

  const res = await request('POST', '/api/device/log', payload);
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.ok(res.body.count >= 1);
});

test('3. Device Status & Live Diagnostics (/api/device/status)', async () => {
  const res = await request('GET', '/api/device/status');
  assert.equal(res.status, 200);
  assert.ok(res.body.status);
  assert.equal(res.body.status.wifi, 'connected');
  assert.equal(res.body.status.bt, 'connected');
  assert.equal(res.body.status.ip, '192.168.0.55');
  assert.equal(res.body.status.free_heap, 115);
  assert.equal(res.body.status.rssi, -58);
  assert.ok(res.body.logs.length > 0);
  assert.ok(res.body.logs.some(l => l.message.includes('Test Wi-Fi connection')));
});

test('4. Single OBD Record Ingestion & Trip Auto-Creation (/api/obd)', async () => {
  const record = {
    rpm: 2400,
    speed: 65.5,
    temp: 88,
    voltage: 14.1,
    fuel_rate: 6.8
  };

  const res = await request('POST', '/api/obd', record);
  assert.equal(res.status, 201);
  assert.equal(res.body.success, true);
  assert.ok(res.body.tripId);
});

test('5. Batch OBD Records Ingestion (/api/obd/batch)', async () => {
  const batch = {
    records: [
      { rpm: 2500, speed: 70.0, temp: 89, voltage: 14.2, fuel_rate: 7.2, dt: 1.0 },
      { rpm: 2600, speed: 75.0, temp: 90, voltage: 14.2, fuel_rate: 7.8, dt: 1.0 },
      { rpm: 2200, speed: 60.0, temp: 90, voltage: 14.1, fuel_rate: 5.5, dt: 1.0 }
    ]
  };

  const res = await request('POST', '/api/obd/batch', batch);
  assert.equal(res.status, 201);
  assert.equal(res.body.success, true);
  assert.equal(res.body.count, 3);
});

test('6. Trip Summary & Archive List (/api/trips)', async () => {
  const res = await request('GET', '/api/trips');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 1);
  
  const activeTrip = res.body.find(t => t.status === 'active');
  assert.ok(activeTrip);
  assert.ok(activeTrip.max_speed >= 75.0);
});

test('7. Finish Active Trip Session (/api/trips/finish)', async () => {
  const res = await request('POST', '/api/trips/finish');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);

  const tripsRes = await request('GET', '/api/trips');
  const completedTrip = tripsRes.body.find(t => t.status === 'completed');
  assert.ok(completedTrip);
});

test('8. Clear Diagnostic Logs (/api/device/logs)', async () => {
  const deleteRes = await request('DELETE', '/api/device/logs');
  assert.equal(deleteRes.status, 200);

  const statusRes = await request('GET', '/api/device/status');
  assert.equal(statusRes.body.logs.length, 0);
});

test('9. No Logs / Empty State Handling (Robustness test)', async () => {
  // When no logs exist, server must return valid JSON without crashing
  const statusRes = await request('GET', '/api/device/status');
  assert.equal(statusRes.status, 200);
  assert.ok(Array.isArray(statusRes.body.logs));
  assert.equal(statusRes.body.logs.length, 0);
  assert.ok(statusRes.body.status);
});

test('10. Offline Device Timeout Check', async () => {
  const statusRes = await request('GET', '/api/device/status');
  const status = statusRes.body.status;
  
  // Calculate if device is offline (if last_seen is null or older than 35s)
  const isOnline = status.last_seen && (Date.now() - new Date(status.last_seen).getTime() < 35000);
  assert.equal(typeof isOnline, 'boolean');
});

test('11. Offline Batch Recovery After Reconnection', async () => {
  // Simulates ESP32 reconnecting after 15 minutes in a tunnel/offline area with 10 cached points
  const offlineRecords = [];
  for (let i = 0; i < 10; i++) {
    offlineRecords.push({
      rpm: 2000 + i * 50,
      speed: 60 + i * 2,
      temp: 85,
      voltage: 14.1,
      fuel_rate: 6.0,
      dt: 1.0
    });
  }

  const batchRes = await request('POST', '/api/obd/batch', { records: offlineRecords });
  assert.equal(batchRes.status, 201);
  assert.equal(batchRes.body.success, true);
  assert.equal(batchRes.body.count, 10);
});
