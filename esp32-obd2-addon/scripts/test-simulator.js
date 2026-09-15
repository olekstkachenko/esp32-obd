/**
 * ESP32 OBD2 Live Protocol Simulator
 * Simulates real ESP32 behavior: Wi-Fi connect event, Bluetooth pairing, and live telemetry streaming.
 * Usage: node scripts/test-simulator.js [optional_target_url]
 * Default target: https://mankind-comprised-devotion.ngrok-free.dev
 */

const TARGET_URL = process.argv[2] || 'https://mankind-comprised-devotion.ngrok-free.dev';

console.log(`\n🚗 Starting ESP32 Simulator targeting: ${TARGET_URL}\n`);

async function sendLog(message, level = 'info', bt_status = 'connected', extra = {}) {
  const url = `${TARGET_URL.replace(/\/api\/obd\/?$/, '')}/api/device/log`;
  const payload = {
    message,
    level,
    bt_status,
    wifi_status: 'connected',
    free_heap: Math.floor(100 + Math.random() * 20),
    rssi: -55 - Math.floor(Math.random() * 10),
    ip: '192.168.43.50',
    ...extra
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'ESP32-OBD2-Simulator',
        'ngrok-skip-browser-warning': 'true'
      },
      body: JSON.stringify(payload)
    });
    console.log(`[HTTP ${res.status}] Log: "${message}"`);
  } catch (err) {
    console.error(`❌ Log send failed: ${err.message}`);
  }
}

async function sendTelemetry(rpm, speed, temp, volt, fuel) {
  const url = `${TARGET_URL.replace(/\/api\/obd\/?$/, '')}/api/obd`;
  const payload = { rpm, speed, temp, voltage: volt, fuel_rate: fuel };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'ESP32-OBD2-Simulator',
        'ngrok-skip-browser-warning': 'true'
      },
      body: JSON.stringify(payload)
    });
    console.log(`[HTTP ${res.status}] Telemetry: Speed ${speed} km/h | RPM ${rpm} | Temp ${temp}°C | Volt ${volt}V | Fuel ${fuel} L/h`);
  } catch (err) {
    console.error(`❌ Telemetry send failed: ${err.message}`);
  }
}

async function runSimulation() {
  console.log('--- Step 1: Simulating ESP32 Boot & Wi-Fi Connection ---');
  await sendLog('🚀 ESP32 завантажено! Запуск Bluetooth Master...', 'info', 'connecting');
  await new Promise(r => setTimeout(r, 1000));

  await sendLog("🌐 Wi-Fi підключено до 'Pajero'! IP: 192.168.43.50 (RSSI: -58 dBm)", 'success', 'connecting');
  await new Promise(r => setTimeout(r, 1500));

  console.log('\n--- Step 2: Simulating OBD2 Bluetooth Pairing ---');
  await sendLog("📡 [1/2] Пряме з'єднання з сканером 'OBDII'...", 'info', 'connecting');
  await new Promise(r => setTimeout(r, 1500));

  await sendLog("🎉 УСПІХ! З'єднано по Bluetooth з сканером 'OBDII'!", 'success', 'connected');
  await new Promise(r => setTimeout(r, 1000));

  await sendLog('⚙️ Ініціалізація протоколу ELM327 (ATZ, ATSP0, пошук шини CAN/ISO)...', 'info', 'connected');
  await new Promise(r => setTimeout(r, 2000));

  await sendLog('🚀 УСПІХ! Протокол ELM327 успішно ініціалізовано! Почався збір даних телеметрії.', 'success', 'connected');
  await new Promise(r => setTimeout(r, 1000));

  console.log('\n--- Step 3: Simulating 20 seconds of Live Driving Telemetry ---');
  let speed = 0;
  let rpm = 800;
  let temp = 75;
  let volt = 14.2;

  for (let i = 1; i <= 20; i++) {
    // Accelerate and cruise
    if (i < 8) {
      speed += 10;
      rpm = 1500 + speed * 30;
    } else if (i < 15) {
      speed = 70 + Math.sin(i) * 5;
      rpm = 2300 + Math.sin(i) * 100;
    } else {
      speed = Math.max(0, speed - 12);
      rpm = Math.max(800, rpm - 300);
    }
    temp = Math.min(92, temp + 0.8);
    volt = 14.1 + (Math.random() * 0.2 - 0.1);
    const fuel = speed > 0 ? (speed * 0.08 + (rpm / 1000) * 1.5).toFixed(1) : 0.9;

    await sendTelemetry(Math.round(rpm), Math.round(speed), Math.round(temp), Number(volt.toFixed(1)), Number(fuel));
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('\n✅ Simulation finished successfully!');
}

runSimulation();
