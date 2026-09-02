#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include "BluetoothSerial.h"
#include <ELMduino.h>
#include <WiFiClientSecure.h>
#include <vector>

#include "esp_bt_main.h"
#include "esp_gap_bt_api.h"

// --- WiFi Credentials ---
const char* ssid = "Pajero";
const char* password = "090384wifi";

// --- Server Details ---
const char* serverUrlBase = "https://chief-winston-express-times.trycloudflare.com/api/obd";

// --- ELM327 Bluetooth Target ---
const char* elmName = "OBDII";
const char* elmPin = "1234";

// Target ELM327 MAC Address
uint8_t elmMac[6] = {0x00, 0x00, 0x00, 0x33, 0x33, 0x33};

// --- Forward Declarations ---
void sendLog(String message, String level = "info", String bt_status = "");

void clearBluetoothBonds() {
  int dev_num = esp_bt_gap_get_bond_device_num();
  if (dev_num > 0) {
    esp_bd_addr_t dev_list[dev_num];
    esp_bt_gap_get_bond_device_list(&dev_num, dev_list);
    for (int i = 0; i < dev_num; i++) {
      esp_bt_gap_remove_bond_device(dev_list[i]);
    }
  }
}

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

WiFiClientSecure sharedSSLClient;
static bool sslInsecureInitialized = false;

void initSharedSSL() {
  if (!sslInsecureInitialized) {
    sharedSSLClient.setInsecure();
    sslInsecureInitialized = true;
  }
}

void flushLogsToServer() {
  if (logQueue.empty()) return;
  if (WiFi.status() != WL_CONNECTED) return;

  initSharedSSL();
  HTTPClient http;

  String baseUrl = String(serverUrlBase);
  int idx = baseUrl.indexOf("/api/obd");
  String url = (idx >= 0 ? baseUrl.substring(0, idx) : baseUrl) + "/api/device/log";

  int count = 0;
  while (!logQueue.empty() && WiFi.status() == WL_CONNECTED && count < 5) {
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

    http.begin(sharedSSLClient, url);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("User-Agent", "ESP32");
    int code = http.POST(json);
    DEBUG_PORT.printf("[sendLog HTTP] status: %d (%s)\n", code, http.errorToString(code).c_str());
    http.end();

    if (code == 200 || code == 201) {
      logQueue.erase(logQueue.begin());
      count++;
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

  initSharedSSL();
  HTTPClient http;
  String url = String(serverUrlBase);
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

  http.begin(sharedSSLClient, url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("User-Agent", "ESP32");
  int httpCode = http.POST(jsonPayload);
  if (httpCode == 200 || httpCode == 201) {
    DEBUG_PORT.printf("✅ Flushed %d offline records to server (HTTP %d)\n", (int)telemetryBuffer.size(), httpCode);
    telemetryBuffer.clear();
  } else {
    DEBUG_PORT.printf("⚠️ Sync failed (HTTP %d: %s). Buffer size: %d records\n", httpCode, http.errorToString(httpCode).c_str(), (int)telemetryBuffer.size());
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
  clearBluetoothBonds();
  sendLog("🎬 [Крок 1/4] Перевірка Bluetooth. Вільна пам'ять RAM: " + String(ESP.getFreeHeap() / 1024) + " KB", "info", "connecting");

  // Step 1: Fast direct connection by target name "OBDII" (Saves RAM, 0ms scan delay)
  sendLog("📡 [Крок 1/2] Пряме з'єднання з сканером 'OBDII' (PIN '1234')...", "info", "connecting");
  SerialBT.setPin(elmPin);
  if (SerialBT.connect(elmName)) {
    sendLog("🎉 УСПІХ! З'єднано по Bluetooth з сканером '" + String(elmName) + "'!", "success", "connected");
    return true;
  }
  sendLog("⚠️ Пряме підключення не вдалося. Переходимо до розширеного пошуку...", "warn", "connecting");

  bool validMac = !isDummyMac(elmMac);
  if (validMac) {
    char macStr[18];
    snprintf(macStr, sizeof(macStr), "%02X:%02X:%02X:%02X:%02X:%02X", elmMac[0], elmMac[1], elmMac[2], elmMac[3], elmMac[4], elmMac[5]);
    sendLog("📡 Спроба з'єднання за MAC-адресою: " + String(macStr) + "...", "info", "connecting");
    
    SerialBT.setPin(elmPin);
    if (SerialBT.connect(elmMac)) {
      sendLog("🎉 УСПІХ! З'єднано по Bluetooth з MAC [" + String(macStr) + "]!", "success", "connected");
      return true;
    }
  }

  // Step 2: Bluetooth Discovery Inquiry Scan (fallback only if direct connect failed)
  sendLog("🔎 [Крок 2/2] Скануємо Bluetooth-ефір навколо...", "info", "scanning");

  BTScanResults *pResults = SerialBT.getScanResults();
  if (SerialBT.discover(4000)) {
    pResults = SerialBT.getScanResults();
    int count = pResults ? pResults->getCount() : 0;
    sendLog("📡 Знайдено " + String(count) + " пристроїв:", "info", "scanning");

    for (int i = 0; i < count; i++) {
      BTAdvertisedDevice *dev = pResults->getDevice(i);
      String devName = String(dev->getName().c_str());
      String devAddr = String(dev->getAddress().toString().c_str());
      int rssi = dev->getRSSI();

      sendLog("  📱 #" + String(i+1) + ": " + (devName.length() > 0 ? devName : "<Приховане ім'я>") + 
              " [" + devAddr + "] Сигнал: " + String(rssi) + " dBm", "info", "scanning");

      String lowerName = devName;
      lowerName.toLowerCase();
      if (lowerName.indexOf("obd") >= 0 || lowerName.indexOf("elm") >= 0 || lowerName.indexOf("linker") >= 0 || lowerName.indexOf("car") >= 0) {
        sendLog("🎯 Виявлено сканер '" + devName + "'! Спроба підключення...", "info", "connecting");

        for (const char* p : pins) {
          SerialBT.setPin(p);
          if (SerialBT.connect(dev->getAddress())) {
            sendLog("🎉 УСПІХ! З'єднано з '" + devName + "' [" + devAddr + "]!", "success", "connected");
            return true;
          }
        }
      }
    }
  }

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
    if (myELM327.begin(ELM_PORT, false, 2000)) {
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
  // Throttle log flushing to once every 3 seconds to prevent RAM exhaustion
  static unsigned long lastLogFlush = 0;
  if (WiFi.status() == WL_CONNECTED && (millis() - lastLogFlush > 3000)) {
    lastLogFlush = millis();
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

      float volt = myELM327.batteryVoltage();
      float rpm = myELM327.rpm();
      float speed = myELM327.kph();
      float temp = myELM327.engineCoolantTemp();
      float maf = myELM327.mafRate();

      if (isnan(volt) || volt < 0 || volt > 30.0) volt = 0;
      if (isnan(rpm) || rpm < 0) rpm = 0;
      if (isnan(speed) || speed < 0) speed = 0;
      if (isnan(temp) || temp < 0) temp = 0;
      if (isnan(maf) || maf < 0) maf = 0;

      float fuel_rate = (maf > 0) ? (maf * 3600.0 / 14.7 / 717.0) : 0;

      // Always push telemetry if voltage > 0 or RPM > 0 or ELM_SUCCESS
      if (volt > 0 || rpm > 0 || speed > 0 || myELM327.nb_rx_state == ELM_SUCCESS) {
        DEBUG_PORT.printf("✅ DATA: RPM: %.0f | Speed: %.0f km/h | Temp: %.0f C | Volt: %.1f V | Fuel: %.1f L/h | Buffer: %d\n", 
                          rpm, speed, temp, volt, fuel_rate, (int)telemetryBuffer.size());
        
        if (telemetryBuffer.size() >= MAX_BUFFER_SIZE) {
          telemetryBuffer.erase(telemetryBuffer.begin());
        }
        telemetryBuffer.push_back({rpm, speed, temp, volt, fuel_rate, dt});

        if (WiFi.status() == WL_CONNECTED) {
          flushBufferToServer();
        }
      }
    }
  }
}
