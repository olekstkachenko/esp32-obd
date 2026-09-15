const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// =========================================================================
// 💾 SIMULATION TEST: ESP32 SPIFFS Flash Logging & Serial DUMP Engine
// =========================================================================

const TEST_LOG_PATH = path.join(__dirname, 'test_obd_debug.log');
const MAX_LOG_FILE_BYTES = 65536; // 64 KB

class MockSpiffsEngine {
  constructor(filePath) {
    this.filePath = filePath;
    this.mounted = true;
  }

  writeLogToFlash(line) {
    if (!this.mounted) return false;

    // Check size & rotate if exceeds 64KB
    if (fs.existsSync(this.filePath)) {
      const stats = fs.statSync(this.filePath);
      if (stats.size > MAX_LOG_FILE_BYTES) {
        fs.unlinkSync(this.filePath);
      }
    }

    fs.appendFileSync(this.filePath, line + '\n', 'utf8');
    return true;
  }

  handleSerialCommand(cmd) {
    const trimmed = cmd.trim().toUpperCase();
    if (['DUMP', 'LOGS', 'GET_LOGS', 'LOG'].includes(trimmed)) {
      if (!fs.existsSync(this.filePath)) {
        return '⚠️ Файл логів /obd_debug.log ще не створено або він пустий.';
      }
      return fs.readFileSync(this.filePath, 'utf8');
    }

    if (['CLEAR', 'CLEAR_LOGS'].includes(trimmed)) {
      if (fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath);
      }
      return '✅ Flash-логи /obd_debug.log успішно очищено.';
    }

    return null;
  }
}

test.before(() => {
  if (fs.existsSync(TEST_LOG_PATH)) fs.unlinkSync(TEST_LOG_PATH);
});

test.after(() => {
  if (fs.existsSync(TEST_LOG_PATH)) fs.unlinkSync(TEST_LOG_PATH);
});

test('1. Flash Log: Record Writing with Timestamps and Vehicle Events', () => {
  const spiffs = new MockSpiffsEngine(TEST_LOG_PATH);

  spiffs.writeLogToFlash('[1s] [info] 🚀 ESP32 успішно завантажено!');
  spiffs.writeLogToFlash("[2s] [info] 📡 [1/2] Пряме з'єднання з сканером 'OBDII'...");
  spiffs.writeLogToFlash("[3s] [success] 🎉 УСПІХ! З'єднано по Bluetooth з сканером 'OBDII'!");
  spiffs.writeLogToFlash("[15s] [success] 🌐 Wi-Fi підключено до 'Pajero'! IP: 192.168.43.50");

  assert.ok(fs.existsSync(TEST_LOG_PATH));
  const content = fs.readFileSync(TEST_LOG_PATH, 'utf8');
  assert.ok(content.includes('OBDII'));
  assert.ok(content.includes('192.168.43.50'));
});

test('2. Flash Log: Power Cut / Reboot Persistence Simulation', () => {
  // Simulate ESP32 being suddenly unplugged from car and re-mounted on PC
  const spiffsAfterPowerCut = new MockSpiffsEngine(TEST_LOG_PATH);
  
  // Dump content after power cycle
  const dumped = spiffsAfterPowerCut.handleSerialCommand('DUMP');
  assert.ok(dumped);
  assert.ok(dumped.includes('ESP32 успішно завантажено'));
  assert.ok(dumped.includes('192.168.43.50'));
});

test('3. Flash Log: 64 KB Boundary Rotation & Overfill Prevention', () => {
  const spiffs = new MockSpiffsEngine(TEST_LOG_PATH);

  // Generate over 1,500 heavy telemetry log lines (~75 KB)
  for (let i = 0; i < 1500; i++) {
    spiffs.writeLogToFlash(`[${i}s] [telemetry] RPM: 2400 | Speed: 85 km/h | Temp: 89 C | Volt: 14.2 V | Fuel: 8.4 L/h`);
  }

  assert.ok(fs.existsSync(TEST_LOG_PATH));
  const fileSize = fs.statSync(TEST_LOG_PATH).size;
  // Must never exceed 64 KB flash quota
  assert.ok(fileSize <= MAX_LOG_FILE_BYTES, `File size ${fileSize} exceeds ${MAX_LOG_FILE_BYTES}`);
  assert.ok(fileSize > 0);
});

test('4. Flash Log: Serial "DUMP" Command Output Validation', () => {
  const spiffs = new MockSpiffsEngine(TEST_LOG_PATH);
  const output = spiffs.handleSerialCommand('dump'); // Case-insensitive
  
  assert.ok(typeof output === 'string');
  assert.ok(output.length > 0);
  assert.ok(output.includes('RPM: 2400'));
});

test('5. Flash Log: Serial "CLEAR" Command Reset', () => {
  const spiffs = new MockSpiffsEngine(TEST_LOG_PATH);
  const clearRes = spiffs.handleSerialCommand('CLEAR');
  
  assert.equal(clearRes, '✅ Flash-логи /obd_debug.log успішно очищено.');
  assert.equal(fs.existsSync(TEST_LOG_PATH), false);

  // Dump after clear should return empty warning
  const emptyDump = spiffs.handleSerialCommand('DUMP');
  assert.ok(emptyDump.includes('ще не створено або він пустий'));
});
