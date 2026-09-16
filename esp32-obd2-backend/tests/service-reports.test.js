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
        resolve({ status: res.statusCode, headers: res.headers, body: json !== null ? json : data });
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

test('SERVICE 1: Odometer base and total distance accumulation', async () => {
  // Check default base odometer (215000)
  const odoRes = await request('GET', '/api/service/odometer');
  assert.equal(odoRes.status, 200);
  assert.equal(odoRes.body.success, true);
  assert.equal(odoRes.body.base_odometer, 215000);
  assert.equal(odoRes.body.current_odometer, 215000);

  // Calibrate base odometer to 220000
  const setOdoRes = await request('POST', '/api/service/odometer', { odometer_base: 220000 });
  assert.equal(setOdoRes.status, 200);
  assert.equal(setOdoRes.body.base_odometer, 220000);
  assert.equal(setOdoRes.body.current_odometer, 220000);

  // Ingest telemetry with distance using batch endpoint
  await request('POST', '/api/obd/batch', {
    records: [
      { speed: 60, rpm: 2000, temp: 90, voltage: 14.1, fuel_rate: 9.5, dt: 60 }
    ]
  });

  const updatedOdoRes = await request('GET', '/api/service/odometer');
  assert.equal(updatedOdoRes.status, 200);
  assert.ok(updatedOdoRes.body.current_odometer >= 220001, 'Current odometer should reflect base + trip distance');
});

test('SERVICE 2: 10 Seeded Pajero 4 Maintenance Items and Health Computation', async () => {
  const res = await request('GET', '/api/service/items');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.ok(Array.isArray(res.body.items));
  assert.ok(res.body.items.length >= 10, 'Should have at least 10 seeded maintenance items');

  const engineOil = res.body.items.find(i => i.title.includes('Моторне мастило'));
  assert.ok(engineOil, 'Engine oil item must exist');
  assert.equal(engineOil.interval_km, 8000);
  assert.ok(typeof engineOil.km_remaining === 'number');
  assert.ok(typeof engineOil.percent_used === 'number');
  assert.ok(['ok', 'warning', 'overdue'].includes(engineOil.status));
});

test('SERVICE 3: Add Custom Maintenance Item', async () => {
  const newItem = {
    title: 'Заміна ламп ксенону D2S',
    category: 'electrical',
    interval_km: 50000,
    interval_months: 24,
    icon: '💡',
    notes: 'Osram Night Breaker Laser'
  };

  const res = await request('POST', '/api/service/items', newItem);
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.ok(res.body.id > 0);

  const itemsRes = await request('GET', '/api/service/items');
  const found = itemsRes.body.items.find(i => i.id === res.body.id);
  assert.ok(found);
  assert.equal(found.title, newItem.title);
  assert.equal(found.interval_km, 50000);
  assert.equal(found.icon, '💡');
});

test('SERVICE 4: Record Service Replacement and Check Service Logs History', async () => {
  const itemsRes = await request('GET', '/api/service/items');
  const engineOil = itemsRes.body.items.find(i => i.title.includes('Моторне мастило'));
  assert.ok(engineOil);

  // Perform replacement
  const replaceRes = await request('POST', `/api/service/items/${engineOil.id}/replace`, {
    cost: 3200,
    date: '2026-09-15T10:00:00.000Z',
    notes: 'Мастило Idemitsu 5W-30 (4.5л) + фільтр Mahle OC196',
    odometer: 220050
  });
  assert.equal(replaceRes.status, 200);
  assert.equal(replaceRes.body.success, true);

  // Verify item state updated
  const updatedItemsRes = await request('GET', '/api/service/items');
  const updatedOil = updatedItemsRes.body.items.find(i => i.id === engineOil.id);
  assert.equal(updatedOil.last_service_odometer, 220050);

  // Verify log history entry
  const logsRes = await request('GET', '/api/service/logs');
  assert.equal(logsRes.status, 200);
  assert.ok(Array.isArray(logsRes.body.logs));
  assert.ok(logsRes.body.logs.length >= 1);
  const log = logsRes.body.logs[0];
  assert.equal(log.cost, 3200);
  assert.equal(log.odometer, 220050);
  assert.ok(log.notes.includes('Idemitsu'));
});

test('SERVICE 5: Update and Delete Service Item', async () => {
  // Add temporary item
  const addRes = await request('POST', '/api/service/items', {
    title: 'Тимчасовий пункт',
    interval_km: 15000
  });
  const id = addRes.body.id;

  // Update item
  const updateRes = await request('PUT', `/api/service/items/${id}`, {
    title: 'Оновлений пункт',
    interval_km: 20000
  });
  assert.equal(updateRes.status, 200);

  // Delete item
  const delRes = await request('DELETE', `/api/service/items/${id}`);
  assert.equal(delRes.status, 200);

  const itemsRes = await request('GET', '/api/service/items');
  const found = itemsRes.body.items.find(i => i.id === id);
  assert.equal(found, undefined);
});

test('REPORTS 1: Summary Statistics and Cost of Ownership Calculation', async () => {
  const summaryRes = await request('GET', '/api/reports/summary?period=all');
  assert.equal(summaryRes.status, 200);
  assert.equal(summaryRes.body.success, true);
  assert.ok(summaryRes.body.total_trips >= 1);
  assert.ok(typeof summaryRes.body.total_distance_km === 'number');
  assert.ok(typeof summaryRes.body.total_fuel_liters === 'number');
  assert.ok(typeof summaryRes.body.total_cost_uah === 'number');
  assert.ok(typeof summaryRes.body.cost_per_km_uah === 'number');
  assert.ok(typeof summaryRes.body.avg_consumption_l100km === 'number');
});

test('REPORTS 2: CSV Export with Excel UTF-8 BOM Header', async () => {
  const csvRes = await request('GET', '/api/analytics/export/csv?period=all');
  assert.equal(csvRes.status, 200);
  assert.ok(csvRes.headers['content-type'].includes('text/csv'));
  assert.ok(csvRes.headers['content-disposition'].includes('.csv'));

  const csvBody = csvRes.body;
  assert.ok(typeof csvBody === 'string');
  assert.ok(csvBody.startsWith('\uFEFF'), 'CSV must start with UTF-8 BOM for Microsoft Excel');
  assert.ok(csvBody.includes('Початок поїздки'));
  assert.ok(csvBody.includes('Вартість (грн)'));
  assert.ok(csvBody.includes('Сер. розхід (л/100км)'));
});

test('REPORTS 3: Telegram Summary Report Generation', async () => {
  const tgRes = await request('POST', '/api/reports/telegram-summary', { period: 'month' });
  assert.equal(tgRes.status, 200);
  assert.equal(tgRes.body.success, true);
  assert.ok(tgRes.body.message.includes('Звіт сформовано'));
});
