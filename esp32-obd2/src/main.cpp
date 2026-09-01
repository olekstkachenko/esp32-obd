#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include "BluetoothSerial.h"
#include <ELMduino.h>
#include <WiFiClientSecure.h>
#include <vector>

// --- WiFi Credentials ---
const char* ssid = "Pajero";
const char* password = "090384wifi";

// --- Server Details ---
const char* serverUrlBase = "http://mankind-comprised-devotion.ngrok-free.dev/api/obd";

// --- ELM327 Bluetooth Target ---
const char* elmName = "OBDII";
const char* elmPin = "1234";

// Target ELM327 MAC Address
uint8_t elmMac[6] = {0x00, 0x00, 0x00, 0x33, 0x33, 0x33};

// --- Forward Declarations ---
void sendLog(String message, String level = "info", String bt_status = "");

BluetoothSerial SerialBT;
#define ELM_PORT SerialBT
#define DEBUG_PORT Serial

ELM327 myELM327;

unsigned long lastUpdate = 0;
const unsigned long updateInterval = 1000; // 1 second
unsigned long lastWifiRetry = 0;
unsigned long lastELMRetry = 0;

struct OBDRecord {
  float rpm;
  float speed;
  float temp;
  float volt;
  float fuel;
  float dt;
};

std::vector<OBDRecord> telemetryBuffer;
const size_t MAX_BUFFER_SIZE = 1800; // Store up to ~30 minutes of offline telemetry

void startWiFi() {
  if (WiFi.status() != WL_CONNECTED) {
    DEBUG_PORT.println("Connecting to WiFi (non-blocking)...");
    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid, password);
  } else {
    static bool loggedWifiConnected = false;
    if (!loggedWifiConnected) {
      loggedWifiConnected = true;
      sendLog("🌐 Wi-Fi підключено до '" + String(ssid) + "'! IP: " + WiFi.localIP().toString() + " (Сигнал RSSI: " + String(WiFi.RSSI()) + " dBm)", "success");
    }
  }
}

struct LogEntry {
  String message;
  String level;
  String bt_status;
};

std::vector<LogEntry> logQueue;

void flushLogsToServer() {
  if (logQueue.empty()) return;
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String baseUrl = String(serverUrlBase);
  int idx = baseUrl.indexOf("/api/obd");
  String url = (idx >= 0 ? baseUrl.substring(0, idx) : baseUrl) + "/api/device/log";
  url.replace("https://", "http://");

  while (!logQueue.empty() && WiFi.status() == WL_CONNECTED) {
    LogEntry entry = logQueue.front();

    String cleanMsg = entry.message;
    cleanMsg.replace("\"", "'");
    cleanMsg.replace("\n", " ");

    String json = "{";
    json += "\"message\":\"" + cleanMsg + "\",";
    json += "\"level\":\"" + entry.level + "\"";
    if (entry.bt_status.length() > 0) {
      json += ",\"bt_status\":\"" + entry.bt_status + "\"";
    }
    json += "}";

    WiFiClient client;
    http.begin(client, url);
    http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("User-Agent", "ESP32");
    http.addHeader("ngrok-skip-browser-warning", "true");
    int code = http.POST(json);
    DEBUG_PORT.printf("[sendLog HTTP] status: %d\n", code);
    http.end();

    if (code > 0) {
      logQueue.erase(logQueue.begin());
    } else {
      break;
    }
  }
}

void sendLog(String message, String level, String bt_status) {
  DEBUG_PORT.println("[" + level + "] " + message);

  LogEntry entry = {message, level, bt_status};
  logQueue.push_back(entry);
  if (logQueue.size() > 60) logQueue.erase(logQueue.begin());

  flushLogsToServer();
}


void flushBufferToServer() {
  if (telemetryBuffer.empty()) return;
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = String(serverUrlBase);
  url.replace("https://", "http://");
  if (telemetryBuffer.size() > 1) url += "/batch";

  String jsonPayload;
  if (telemetryBuffer.size() == 1) {
    const auto& r = telemetryBuffer[0];
    jsonPayload = "{";
    jsonPayload += "\"rpm\":" + String(r.rpm, 1) + ",";
    jsonPayload += "\"speed\":" + String(r.speed, 1) + ",";
    jsonPayload += "\"temp\":" + String(r.temp, 1) + ",";
    jsonPayload += "\"voltage\":" + String(r.volt, 1) + ",";
    jsonPayload += "\"fuel_rate\":" + String(r.fuel, 1);
    jsonPayload += "}";
  } else {
    jsonPayload = "{\"records\":[";
    for (size_t i = 0; i < telemetryBuffer.size(); i++) {
      const auto& r = telemetryBuffer[i];
      if (i > 0) jsonPayload += ",";
      jsonPayload += "{\"rpm\":" + String(r.rpm, 1) +
                     ",\"speed\":" + String(r.speed, 1) +
                     ",\"temp\":" + String(r.temp, 1) +
                     ",\"voltage\":" + String(r.volt, 1) +
                     ",\"fuel_rate\":" + String(r.fuel, 1) +
                     ",\"dt\":" + String(r.dt, 1) + "}";
    }
    jsonPayload += "]}";
  }

  WiFiClient client;
  http.begin(client, url);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("User-Agent", "ESP32");
  http.addHeader("ngrok-skip-browser-warning", "true");
  int httpCode = http.POST(jsonPayload);
  if (httpCode == 200 || httpCode == 201 || httpCode == 307) {
    DEBUG_PORT.printf("✅ Flushed %d offline records to server (HTTP %d)\n", (int)telemetryBuffer.size(), httpCode);
    telemetryBuffer.clear();
  } else {
    DEBUG_PORT.printf("⚠️ Sync failed (HTTP %d). Buffer size: %d records\n", httpCode, (int)telemetryBuffer.size());
  }
  http.end();
}


bool elmConnected = false;
bool elmInitialized = false;

bool isDummyMac(uint8_t mac[6]) {
  if (mac[0] == 0x00 && mac[1] == 0x00 && mac[2] == 0x00 && mac[3] == 0x00 && mac[4] == 0x00 && mac[5] == 0x00) return true;
  if (mac[0] == 0x00 && mac[1] == 0x00 && mac[2] == 0x00 && mac[3] == 0x33 && mac[4] == 0x33 && mac[5] == 0x33) return true;
  if (mac[0] == 0x02 && mac[1] == 0x00 && mac[2] == 0x00 && mac[3] == 0x00 && mac[4] == 0x00 && mac[5] == 0x00) return true;
  return false;
}

const char* targetNames[] = {"OBDII", "OBD2", "ELM327", "vLinker", "Viecar", "OBD-II"};
const char* pins[] = {"1234", "0000", "6789", "1111", "8888", "123456", ""};

bool connectToELM327() {
  sendLog("🎬 [Крок 1/4] Перевірка Bluetooth. Вільна пам'ять RAM: " + String(ESP.getFreeHeap() / 1024) + " KB", "info", "connecting");

  bool validMac = !isDummyMac(elmMac);

  if (validMac) {
    char macStr[18];
    snprintf(macStr, sizeof(macStr), "%02X:%02X:%02X:%02X:%02X:%02X", elmMac[0], elmMac[1], elmMac[2], elmMac[3], elmMac[4], elmMac[5]);
    sendLog("📡 Спроба з'єднання за зафіксованою MAC-адресою: " + String(macStr) + " (PIN " + String(elmPin) + ")...", "info", "connecting");
    
    SerialBT.setPin(elmPin);
    if (SerialBT.connect(elmMac)) {
      sendLog("🎉 УСПІХ! З'єднано по Bluetooth з MAC [" + String(macStr) + "]!", "success", "connected");
      return true;
    } else {
      sendLog("❌ З'єднання за MAC [" + String(macStr) + "] не вдалося.", "warn", "connecting");
    }
  }

  // Step 2: Bluetooth Discovery Inquiry Scan
  sendLog("🔎 [Крок 2/4] Скануємо Bluetooth-ефір навколо (6 секунд)...", "info", "scanning");

  BTScanResults *pResults = SerialBT.getScanResults();
  if (SerialBT.discover(6000)) {
    pResults = SerialBT.getScanResults();
    int count = pResults ? pResults->getCount() : 0;
    sendLog("📡 Знайдено " + String(count) + " Bluetooth пристроїв у зоні досяжності:", "info", "scanning");

    for (int i = 0; i < count; i++) {
      BTAdvertisedDevice *dev = pResults->getDevice(i);
      String devName = String(dev->getName().c_str());
      String devAddr = String(dev->getAddress().toString().c_str());
      int rssi = dev->getRSSI();

      sendLog("  📱 #" + String(i+1) + ": " + (devName.length() > 0 ? devName : "<Приховане ім'я>") + 
              " [" + devAddr + "] Сигнал: " + String(rssi) + " dBm", "info", "scanning");

      // Auto-connect if device name matches any OBD pattern
      String lowerName = devName;
      lowerName.toLowerCase();
      if (lowerName.indexOf("obd") >= 0 || lowerName.indexOf("elm") >= 0 || lowerName.indexOf("linker") >= 0 || lowerName.indexOf("car") >= 0) {
        sendLog("🎯 Виявлено схожий OBD2 адаптер '" + devName + "'! Спроба підключення по MAC " + devAddr + "...", "info", "connecting");

        for (const char* p : pins) {
          sendLog("🔑 Спроба підключення з PIN '" + String(p) + "'...", "info", "connecting");
          SerialBT.setPin(p);
          if (SerialBT.connect(dev->getAddress())) {
            sendLog("🎉 УСПІХ! З'єднано по Bluetooth з '" + devName + "' [" + devAddr + "]!", "success", "connected");
            return true;
          } else {
            sendLog("❌ Пристрій '" + devName + "' відхилив PIN '" + String(p) + "'.", "warn", "connecting");
          }
        }
      }
    }
  } else {
    sendLog("⚠️ Сканування закінчилося: жодного пристрою Bluetooth не знайдено.", "warn", "scanning");
  }

  // Step 3: Direct connection by target names
  sendLog("📡 [Крок 3/4] Спроба прямого підключення за ім'ям 'OBDII'...", "info", "connecting");
  for (const char* name : targetNames) {
    for (const char* p : pins) {
      sendLog("🔑 Спроба з'єднання з '" + String(name) + "' (PIN " + String(p) + ")...", "info", "connecting");
      SerialBT.setPin(p);
      if (SerialBT.connect(name)) {
        sendLog("🎉 УСПІХ! З'єднано по Bluetooth з сканером '" + String(name) + "'!", "success", "connected");
        return true;
      }
    }
  }

  sendLog("❌ [Крок 4/4] Жоден спосіб підключення не спрацював. Повторний цикл через 6 секунд...", "error", "disconnected");
  return false;
}

void ensureELMConnected() {
  if (!SerialBT.connected()) {
    elmConnected = false;
    elmInitialized = false;
    
    if (millis() - lastELMRetry > 6000) {
      lastELMRetry = millis();
      if (connectToELM327()) {
        elmConnected = true;
      }
    }
    return;
  }

  if (elmConnected && !elmInitialized) {
    sendLog("⚙️ Bluetooth з'єднання є! Ініціалізуємо протокол ELM327 (AT-команди)...", "info", "connecting");
    if (myELM327.begin(ELM_PORT, true, 3000)) {
      sendLog("🚀 УСПІХ! Протокол ELM327 успішно ініціалізовано! Почався збір даних.", "success", "connected");
      elmInitialized = true;
    } else {
      sendLog("⚠️ Bluetooth з'єднано, але сканер не відповів на протокол ELM327 (повтор ініціалізації)...", "warn", "connecting");
    }
  }
}

void setup() {
  DEBUG_PORT.begin(115200);
  startWiFi();

  sendLog("🚀 ESP32 завантажено! Запуск Bluetooth Master...", "info");

  SerialBT.setPin(elmPin);
  ELM_PORT.begin("ESP32-OBD2", true); // Master mode
  DEBUG_PORT.println("Bluetooth Master mode ready.");
}

void loop() {
  // Always flush any queued system logs when WiFi is connected
  if (WiFi.status() == WL_CONNECTED) {
    flushLogsToServer();
  }

  // Re-check WiFi connection every 10 seconds if disconnected
  if (WiFi.status() != WL_CONNECTED && (millis() - lastWifiRetry > 10000)) {
    lastWifiRetry = millis();
    DEBUG_PORT.println("Retrying WiFi connection...");
    WiFi.begin(ssid, password);
  }

  // Maintain Bluetooth OBD2 connection
  ensureELMConnected();

  if (elmInitialized && SerialBT.connected()) {
    if (millis() - lastUpdate > updateInterval) {
      float dt = (millis() - lastUpdate) / 1000.0;
      lastUpdate = millis();

      float rpm = myELM327.rpm();
      float speed = myELM327.kph();
      float temp = myELM327.engineCoolantTemp();
      float volt = myELM327.batteryVoltage();
      float maf = myELM327.mafRate();

      float fuel_rate = (maf > 0 && myELM327.nb_rx_state == ELM_SUCCESS) ? (maf * 3600.0 / 14.7 / 717.0) : 0;

      if (myELM327.nb_rx_state == ELM_SUCCESS) {
        DEBUG_PORT.printf("RPM: %.0f | Speed: %.0f km/h | Temp: %.0f C | Volt: %.1f V | Fuel: %.1f L/h | Buffer: %d\n", 
                          rpm, speed, temp, volt, fuel_rate, (int)telemetryBuffer.size());
        
        if (telemetryBuffer.size() >= MAX_BUFFER_SIZE) {
          telemetryBuffer.erase(telemetryBuffer.begin());
        }
        telemetryBuffer.push_back({rpm, speed, temp, volt, fuel_rate, dt});

        if (WiFi.status() == WL_CONNECTED) {
          flushBufferToServer();
        }
      } else if (myELM327.nb_rx_state != ELM_GETTING_MSG) {
        DEBUG_PORT.print("ELM327 ERROR: ");
        DEBUG_PORT.println(myELM327.nb_rx_state);
      }
    }
  }
}
