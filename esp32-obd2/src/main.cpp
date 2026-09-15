#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include "BluetoothSerial.h"
#include <ELMduino.h>
#include <WiFiClientSecure.h>
#include <vector>

#include "esp_bt_main.h"
#include "esp_gap_bt_api.h"

#if __has_include("secrets.h")
  #include "secrets.h"
#else
  #include "secrets.example.h"
#endif

// --- Configuration loaded from secrets.h (ignored in Git) ---
const char* ssid = SECRET_WIFI_SSID;
const char* password = SECRET_WIFI_PASSWORD;
const char* serverUrlBase = SECRET_SERVER_URL;
const char* elmName = SECRET_ELM_NAME;
const char* elmPin = SECRET_ELM_PIN;
uint8_t elmMac[6] = SECRET_ELM_MAC;

// --- Forward Declarations ---
void sendLog(String message, String level = "info", String bt_status = "");
void flushLogsToServer();
void checkWiFi();

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
unsigned long lastHeartbeat = 0;

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

struct LogEntry {
  String message;
  String level;
  String bt_status;
};

std::vector<LogEntry> logQueue;

// =========================================================================
// 🚀 Robust HTTP/HTTPS POST Handler (Optimized for 4G/Mobile Hotspots)
// =========================================================================
bool sendHttpPost(const String& url, const String& jsonPayload, int& outCode) {
  if (WiFi.status() != WL_CONNECTED) {
    outCode = -99;
    return false;
  }

  HTTPClient http;
  http.setTimeout(6000); // 6s timeout allows stable cellular 4G TLS handshakes
  http.setReuse(false);

  bool isHttps = url.startsWith("https://");

  if (isHttps) {
    WiFiClientSecure client;
    client.setInsecure(); // Accept Ngrok / Cloudflare SSL certificates
    client.setTimeout(6);

    if (!http.begin(client, url)) {
      DEBUG_PORT.printf("❌ [HTTP HTTPS] http.begin failed: %s\n", url.c_str());
      outCode = -1;
      return false;
    }

    http.addHeader("Content-Type", "application/json");
    http.addHeader("User-Agent", "ESP32-OBD2");
    http.addHeader("ngrok-skip-browser-warning", "true");

    outCode = http.POST(jsonPayload);
    http.end();
  } else {
    WiFiClient client;
    client.setTimeout(6);

    if (!http.begin(client, url)) {
      DEBUG_PORT.printf("❌ [HTTP Plain] http.begin failed: %s\n", url.c_str());
      outCode = -1;
      return false;
    }

    http.addHeader("Content-Type", "application/json");
    http.addHeader("User-Agent", "ESP32-OBD2");
    http.addHeader("ngrok-skip-browser-warning", "true");

    outCode = http.POST(jsonPayload);
    http.end();
  }

  return (outCode >= 200 && outCode < 300);
}

void flushLogsToServer() {
  if (logQueue.empty()) return;
  if (WiFi.status() != WL_CONNECTED) return;

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
    json += "\"level\":\"" + entry.level + "\",";
    json += "\"wifi_status\":\"connected\",";
    json += "\"free_heap\":" + String(ESP.getFreeHeap() / 1024) + ",";
    json += "\"rssi\":" + String(WiFi.RSSI()) + ",";
    json += "\"ip\":\"" + WiFi.localIP().toString() + "\"";
    if (entry.bt_status.length() > 0) {
      json += ",\"bt_status\":\"" + entry.bt_status + "\"";
    }
    json += "}";

    int code = 0;
    bool ok = sendHttpPost(url, json, code);
    DEBUG_PORT.printf("📡 [HTTP Log] %d (%s) | RAM: %d KB | Log: %s\n", 
                      code, ok ? "OK" : "ERR", (int)(ESP.getFreeHeap() / 1024), cleanMsg.c_str());

    if (ok) {
      logQueue.erase(logQueue.begin());
      count++;
    } else {
      break; // Pause until next flush cycle
    }
  }
}

void sendLog(String message, String level, String bt_status) {
  DEBUG_PORT.println("[" + level + "] " + message);

  LogEntry entry = {message, level, bt_status};
  logQueue.push_back(entry);
  if (logQueue.size() > 60) logQueue.erase(logQueue.begin());

  if (WiFi.status() == WL_CONNECTED) {
    flushLogsToServer();
  }
}

void sendHeartbeat() {
  if (WiFi.status() != WL_CONNECTED) return;

  String baseUrl = String(serverUrlBase);
  int idx = baseUrl.indexOf("/api/obd");
  String url = (idx >= 0 ? baseUrl.substring(0, idx) : baseUrl) + "/api/device/log";

  String json = "{";
  json += "\"wifi_status\":\"connected\",";
  json += "\"bt_status\":\"" + String(SerialBT.connected() ? "connected" : "disconnected") + "\",";
  json += "\"free_heap\":" + String(ESP.getFreeHeap() / 1024) + ",";
  json += "\"rssi\":" + String(WiFi.RSSI()) + ",";
  json += "\"ip\":\"" + WiFi.localIP().toString() + "\"";
  json += "}";

  int code = 0;
  sendHttpPost(url, json, code);
}

void flushBufferToServer() {
  if (telemetryBuffer.empty()) return;
  if (WiFi.status() != WL_CONNECTED) return;

  String url = String(serverUrlBase);
  if (telemetryBuffer.size() > 1) url += "/batch";

  String jsonPayload;
  if (telemetryBuffer.size() == 1) {
    jsonPayload.reserve(128);
    const auto& r = telemetryBuffer[0];
    jsonPayload = "{";
    jsonPayload += "\"rpm\":" + String(r.rpm, 1) + ",";
    jsonPayload += "\"speed\":" + String(r.speed, 1) + ",";
    jsonPayload += "\"temp\":" + String(r.temp, 1) + ",";
    jsonPayload += "\"voltage\":" + String(r.volt, 1) + ",";
    jsonPayload += "\"fuel_rate\":" + String(r.fuel, 1);
    jsonPayload += "}";
  } else {
    jsonPayload.reserve(telemetryBuffer.size() * 85 + 32);
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

  int httpCode = 0;
  bool ok = sendHttpPost(url, jsonPayload, httpCode);
  if (ok) {
    DEBUG_PORT.printf("✅ Flushed %d offline records to server (HTTP %d)\n", (int)telemetryBuffer.size(), httpCode);
    telemetryBuffer.clear();
  } else {
    DEBUG_PORT.printf("⚠️ Sync failed (HTTP %d). Buffer: %d records\n", httpCode, (int)telemetryBuffer.size());
  }
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
  sendLog("🎬 Перевірка Bluetooth. Вільна пам'ять RAM: " + String(ESP.getFreeHeap() / 1024) + " KB", "info", "connecting");

  // Step 1: Fast direct connection by target name "OBDII" (Saves RAM, 0ms scan delay)
  sendLog("📡 [1/2] Пряме з'єднання з сканером '" + String(elmName) + "' (PIN '" + String(elmPin) + "')...", "info", "connecting");
  SerialBT.setPin(elmPin);
  if (SerialBT.connect(elmName)) {
    sendLog("🎉 УСПІХ! З'єднано по Bluetooth з сканером '" + String(elmName) + "'!", "success", "connected");
    return true;
  }
  DEBUG_PORT.println("⚠️ Direct name connection timed out.");

  // Step 2: Connection by MAC if provided
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

  // Step 3: Periodic Bluetooth Inquiry Scan (every 25s only)
  static unsigned long lastScanTime = 0;
  if (millis() - lastScanTime > 25000) {
    lastScanTime = millis();
    sendLog("🔎 [2/2] Сканування Bluetooth-ефіру навколо...", "info", "scanning");

    BTScanResults *pResults = SerialBT.getScanResults();
    if (SerialBT.discover(3000)) {
      pResults = SerialBT.getScanResults();
      int count = pResults ? pResults->getCount() : 0;
      sendLog("📡 Знайдено " + String(count) + " пристроїв у зоні дії Bluetooth", "info", "scanning");

      for (int i = 0; i < count; i++) {
        BTAdvertisedDevice *dev = pResults->getDevice(i);
        String devName = String(dev->getName().c_str());
        String devAddr = String(dev->getAddress().toString().c_str());
        int rssi = dev->getRSSI();

        String lowerName = devName;
        lowerName.toLowerCase();
        if (lowerName.indexOf("obd") >= 0 || lowerName.indexOf("elm") >= 0 || lowerName.indexOf("linker") >= 0 || lowerName.indexOf("car") >= 0) {
          sendLog("🎯 Виявлено сканер '" + devName + "' [" + devAddr + "]! Підключення...", "info", "connecting");

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
  }

  return false;
}

String getELMStatusStr(int8_t status) {
  switch (status) {
    case ELM_SUCCESS: return "OK (Успіх)";
    case ELM_NO_RESPONSE: return "NO_RESPONSE (ЕБУ не відповідає / вимкнено запалювання)";
    case ELM_BUFFER_OVERFLOW: return "BUFFER_OVERFLOW (Буфер сканера переповнено)";
    case ELM_GARBAGE: return "GARBAGE_DATA (Помилка протоколу / сміття в шині)";
    case ELM_UNABLE_TO_CONNECT: return "UNABLE_TO_CONNECT (Сканер не зміг підключитися до ЕБУ авто)";
    case ELM_NO_DATA: return "NO_DATA (ЕБУ авто не підтримує даний PID)";
    case ELM_STOPPED: return "STOPPED";
    case ELM_TIMEOUT: return "TIMEOUT (Таймаут відповіді від ЕБУ)";
    default: return "ERROR_CODE_" + String(status);
  }
}

void ensureELMConnected() {
  if (!SerialBT.connected()) {
    elmConnected = false;
    elmInitialized = false;
    
    if (millis() - lastELMRetry > 10000) {
      lastELMRetry = millis();
      if (connectToELM327()) {
        elmConnected = true;
      }
    }
    return;
  }

  if (elmConnected && !elmInitialized) {
    sendLog("⚙️ Bluetooth з'єднання є! Ініціалізуємо протокол ELM327 (AT-команди, пошук шини авто)...", "info", "connecting");
    if (myELM327.begin(ELM_PORT, false, 3000)) {
      sendLog("🚀 УСПІХ! Протокол ELM327 успішно ініціалізовано! Почався збір даних телеметрії.", "success", "connected");
      elmInitialized = true;
    } else {
      sendLog("⚠️ Bluetooth з'єднано, але сканер не відповів на протокол ELM327 (" + getELMStatusStr(myELM327.nb_rx_state) + ")", "warn", "connecting");
    }
  }
}

static bool wasWifiConnected = false;

void checkWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!wasWifiConnected) {
      wasWifiConnected = true;
      String ip = WiFi.localIP().toString();
      int rssi = WiFi.RSSI();
      DEBUG_PORT.printf("\n========================================\n");
      DEBUG_PORT.printf("🌐 Wi-Fi ПІДКЛЮЧЕНО!\n");
      DEBUG_PORT.printf("IP: %s | RSSI: %d dBm | Free Heap: %d KB\n", ip.c_str(), rssi, (int)(ESP.getFreeHeap() / 1024));
      DEBUG_PORT.printf("========================================\n");
      
      sendLog("🌐 Wi-Fi підключено до '" + String(ssid) + "'! IP: " + ip + " (RSSI: " + String(rssi) + " dBm)", "success", "wifi_connected");
      flushLogsToServer();
    }
  } else {
    if (wasWifiConnected) {
      wasWifiConnected = false;
      DEBUG_PORT.println("⚠️ Wi-Fi з'єднання втрачено!");
    }
    if (millis() - lastWifiRetry > 8000) {
      lastWifiRetry = millis();
      DEBUG_PORT.println("🔄 Спроба підключення до Wi-Fi...");
      WiFi.begin(ssid, password);
    }
  }
}

void setup() {
  DEBUG_PORT.begin(115200);
  delay(500);

  DEBUG_PORT.println("\n\n========================================");
  DEBUG_PORT.println("🚗 ESP32 OBD2 Telemetry Logger Starting...");
  DEBUG_PORT.printf("Free Heap: %d KB\n", (int)(ESP.getFreeHeap() / 1024));
  DEBUG_PORT.println("========================================");

  telemetryBuffer.reserve(MAX_BUFFER_SIZE);
  logQueue.reserve(64);

  // 1. Prioritize Wi-Fi connection to mobile hotspot
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  DEBUG_PORT.printf("Connecting to Mobile Hotspot '%s'...\n", ssid);

  unsigned long startWait = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - startWait < 4000)) {
    delay(200);
    DEBUG_PORT.print(".");
  }
  DEBUG_PORT.println();

  if (WiFi.status() == WL_CONNECTED) {
    checkWiFi();
  }

  // 2. Start Bluetooth Master
  sendLog("🚀 ESP32 завантажено! Запуск Bluetooth Master...", "info");
  SerialBT.setPin(elmPin);
  ELM_PORT.begin("ESP32-OBD2", true); // Master mode
  DEBUG_PORT.println("📡 Bluetooth Master mode ready.");
}

void loop() {
  // 1. Monitor Wi-Fi state & handle reconnects
  checkWiFi();

  // 2. Periodic log flushing (every 2.5 seconds)
  static unsigned long lastLogFlush = 0;
  if (WiFi.status() == WL_CONNECTED && (millis() - lastLogFlush > 2500)) {
    lastLogFlush = millis();
    flushLogsToServer();
  }

  // 3. Heartbeat ping (every 10 seconds)
  if (millis() - lastHeartbeat > 10000) {
    lastHeartbeat = millis();
    sendHeartbeat();
  }

  // 4. Maintain Bluetooth OBD2 connection
  ensureELMConnected();

  // 5. Query OBD2 telemetry if connected
  if (elmInitialized && SerialBT.connected()) {
    if (millis() - lastUpdate > updateInterval) {
      float dt = (millis() - lastUpdate) / 1000.0;
      lastUpdate = millis();

      float volt = myELM327.batteryVoltage();
      float rpm = myELM327.rpm();
      float speed = myELM327.kph();
      float temp = myELM327.engineCoolantTemp();
      float maf = myELM327.mafRate();

      static int consecutiveErrors = 0;

      if (myELM327.nb_rx_state != ELM_SUCCESS && (isnan(rpm) || rpm <= 0) && (isnan(volt) || volt <= 0)) {
        consecutiveErrors++;
        if (consecutiveErrors % 5 == 0) {
          sendLog("⚠️ Збій зчитування з авто: " + getELMStatusStr(myELM327.nb_rx_state) + " (Спроб: " + String(consecutiveErrors) + ")", "warn", "connected");
        }
        if (consecutiveErrors >= 15) {
          sendLog("🔄 Занадто багато помилок зчитування від ЕБУ авто. Перезапуск протоколу ELM327...", "warn", "connecting");
          elmInitialized = false;
          consecutiveErrors = 0;
        }
      } else {
        consecutiveErrors = 0;
      }

      if (isnan(volt) || volt < 0 || volt > 30.0) volt = 0;
      if (isnan(rpm) || rpm < 0) rpm = 0;
      if (isnan(speed) || speed < 0) speed = 0;
      if (isnan(temp) || temp < -40 || temp > 200) temp = 0;
      if (isnan(maf) || maf < 0) maf = 0;

      float fuel_rate = (maf > 0) ? (maf * 3600.0 / 14.7 / 717.0) : 0;

      if (volt > 0 || rpm > 0 || speed > 0 || temp > 0 || myELM327.nb_rx_state == ELM_SUCCESS) {
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
