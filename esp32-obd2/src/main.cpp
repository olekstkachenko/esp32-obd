// =========================================================================
// 🚗 ESP32 OBD2 Telemetry Logger for Mitsubishi Pajero Wagon 4
// 📡 Bluetooth ELM327 ("OBDII") -> ESP32 -> 4G Wi-Fi -> Home Assistant
// =========================================================================

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include "BluetoothSerial.h"
#include <ELMduino.h>
#include <WiFiClientSecure.h>
#include <vector>
#include <time.h>
#include <FS.h>
#include <SPIFFS.h>

#include "esp_bt_main.h"
#include "esp_gap_bt_api.h"

#if __has_include("secrets.h")
  #include "secrets.h"
#else
  #include "secrets.example.h"
#endif

BluetoothSerial SerialBT;
#define ELM_PORT SerialBT
#define DEBUG_PORT Serial

// --- Configuration loaded from secrets.h (ignored in Git) ---
const char* ssid = SECRET_WIFI_SSID;
const char* password = SECRET_WIFI_PASSWORD;
const char* serverUrlBase = SECRET_SERVER_URL;
const char* elmName = SECRET_ELM_NAME;
const char* elmPin = SECRET_ELM_PIN;
uint8_t elmMac[6] = SECRET_ELM_MAC;

// --- Persistent Flash Logging (Optimized with Zero Redundant I/O) ---
const char* LOG_FILE_PATH = "/obd_debug.log";
const size_t MAX_LOG_FILE_BYTES = 65536; // 64 KB maximum log file size in Flash
static bool spiffsMounted = false;
static size_t currentFlashLogBytes = 0;

void initSpiffsLogging() {
  spiffsMounted = SPIFFS.begin(true);
  if (spiffsMounted && SPIFFS.exists(LOG_FILE_PATH)) {
    File f = SPIFFS.open(LOG_FILE_PATH, FILE_READ);
    if (f) {
      currentFlashLogBytes = f.size();
      f.close();
    }
  }
}

void writeLogToFlash(const String& line) {
  if (!spiffsMounted) return;
  
  // Fast RAM-cached size tracking (0 flash read overhead on every write)
  size_t lineBytes = line.length() + 2;
  if (currentFlashLogBytes + lineBytes > MAX_LOG_FILE_BYTES) {
    SPIFFS.remove(LOG_FILE_PATH);
    currentFlashLogBytes = 0;
  }

  File f = SPIFFS.open(LOG_FILE_PATH, FILE_APPEND);
  if (f) {
    f.println(line);
    f.close();
    currentFlashLogBytes += lineBytes;
  }
}

void dumpLogsToSerial() {
  DEBUG_PORT.println("\n========================================================");
  DEBUG_PORT.println("📜 [START OF ESP32 SPIFFS FLASH LOG DUMP]");
  DEBUG_PORT.println("========================================================");
  if (spiffsMounted && SPIFFS.exists(LOG_FILE_PATH)) {
    File f = SPIFFS.open(LOG_FILE_PATH, FILE_READ);
    if (f) {
      char buf[256];
      while (f.available()) {
        size_t bytesRead = f.readBytes(buf, sizeof(buf));
        DEBUG_PORT.write((const uint8_t*)buf, bytesRead);
      }
      f.close();
    }
  } else {
    DEBUG_PORT.println("⚠️ Файл логів /obd_debug.log ще не створено або він пустий.");
  }
  DEBUG_PORT.println("\n========================================================");
  DEBUG_PORT.println("📜 [END OF ESP32 SPIFFS FLASH LOG DUMP]");
  DEBUG_PORT.println("========================================================\n");
}

// --- Forward Declarations ---
void sendLog(const String& message, const String& level = "info", const String& bt_status = "");
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

ELM327 myELM327;

unsigned long lastUpdate = 0;
unsigned long updateInterval = 1000; // 1s active, 3s idle
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
const size_t MAX_BUFFER_SIZE = 1800; // Store up to ~30 minutes of offline telemetry (RAM safe)

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
  http.setTimeout(8000); // 8000ms timeout allows stable cellular 4G TLS handshakes
  http.setReuse(false);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);

  bool isHttps = url.startsWith("https://");

  if (isHttps) {
    WiFiClientSecure client;
    client.setInsecure(); // Accept Ngrok / Cloudflare SSL certificates
    client.setTimeout(8000); // 8000 milliseconds (8 seconds)

    if (!http.begin(client, url)) {
      DEBUG_PORT.printf("❌ [HTTP HTTPS] http.begin failed for: %s\n", url.c_str());
      outCode = -1;
      return false;
    }

    http.addHeader("Content-Type", "application/json");
    http.addHeader("User-Agent", "ESP32-OBD2-Pajero4");
    http.addHeader("ngrok-skip-browser-warning", "true");

    outCode = http.POST(jsonPayload);
    DEBUG_PORT.printf("📡 [HTTP HTTPS] Code: %d (%s) | Free RAM: %d KB\n", 
                      outCode, http.errorToString(outCode).c_str(), (int)(ESP.getFreeHeap() / 1024));
    http.end();
  } else {
    WiFiClient client;
    client.setTimeout(8000); // 8000 milliseconds

    if (!http.begin(client, url)) {
      DEBUG_PORT.printf("❌ [HTTP Plain] http.begin failed for: %s\n", url.c_str());
      outCode = -1;
      return false;
    }

    http.addHeader("Content-Type", "application/json");
    http.addHeader("User-Agent", "ESP32-OBD2-Pajero4");
    http.addHeader("ngrok-skip-browser-warning", "true");

    outCode = http.POST(jsonPayload);
    DEBUG_PORT.printf("📡 [HTTP Plain] Code: %d (%s) | Free RAM: %d KB\n", 
                      outCode, http.errorToString(outCode).c_str(), (int)(ESP.getFreeHeap() / 1024));
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

    if (ok) {
      logQueue.erase(logQueue.begin());
      count++;
    } else {
      break; // Pause until next flush cycle
    }
  }
}

void sendLog(const String& message, const String& level, const String& bt_status) {
  String timestampStr = "[" + String(millis() / 1000) + "s] [" + level + "] " + message;
  DEBUG_PORT.println(timestampStr);
  writeLogToFlash(timestampStr);

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
    DEBUG_PORT.printf("✅ [Buffer Sync] Відправлено %d записів на сервер (HTTP %d)\n", (int)telemetryBuffer.size(), httpCode);
    telemetryBuffer.clear();
  } else {
    DEBUG_PORT.printf("⚠️ [Buffer Sync] Збій синхронізації (HTTP %d). Буфер: %d записів\n", httpCode, (int)telemetryBuffer.size());
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

  // Крок 1: Пряме швидке підключення до імені "OBDII" (PIN: 1234)
  sendLog("📡 [1/2] Пряме з'єднання з сканером '" + String(elmName) + "' (PIN '" + String(elmPin) + "')...", "info", "connecting");
  SerialBT.setPin(elmPin);
  if (SerialBT.connect(elmName)) {
    sendLog("🎉 УСПІХ! З'єднано по Bluetooth з сканером '" + String(elmName) + "'!", "success", "connected");
    return true;
  }
  DEBUG_PORT.println("⚠️ Direct name connection timed out.");

  // Крок 2: Підключення за MAC (якщо вказано)
  bool validMac = !isDummyMac(elmMac);
  if (validMac) {
    char macStr[18];
    snprintf(macStr, sizeof(macStr), "%02X:%02X:%02X:%02X:%02X:%02X", elmMac[0], elmMac[1], elmMac[2], elmMac[3], elmMac[4], elmMac[5]);
    sendLog("📡 Спроба з'єднання за MAC: " + String(macStr) + "...", "info", "connecting");
    
    SerialBT.setPin(elmPin);
    if (SerialBT.connect(elmMac)) {
      sendLog("🎉 УСПІХ! З'єднано по Bluetooth з MAC [" + String(macStr) + "]!", "success", "connected");
      return true;
    }
  }

  // Крок 3: Періодичне сканування ефіру (раз на 25 секунд)
  static unsigned long lastScanTime = 0;
  if (millis() - lastScanTime > 25000) {
    lastScanTime = millis();
    sendLog("🔎 [2/2] Автосканування Bluetooth-ефіру...", "info", "scanning");

    BTScanResults *pResults = SerialBT.getScanResults();
    if (SerialBT.discover(3000)) {
      pResults = SerialBT.getScanResults();
      int count = pResults ? pResults->getCount() : 0;
      sendLog("📡 Знайдено " + String(count) + " пристроїв Bluetooth", "info", "scanning");

      for (int i = 0; i < count; i++) {
        BTAdvertisedDevice *dev = pResults->getDevice(i);
        String devName = String(dev->getName().c_str());
        String devAddr = String(dev->getAddress().toString().c_str());

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
    default: return "STATUS_CODE_" + String(status);
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
    sendLog("⚙️ Bluetooth з'єднання є! Ініціалізуємо протокол Pajero 4 CAN...", "info", "connecting");
    if (myELM327.begin(ELM_PORT, false, 2500)) {
      sendLog("🚀 УСПІХ! Протокол ELM327 зв'язано з ЕБУ Pajero 4! Почався збір даних.", "success", "connected");
      elmInitialized = true;
    } else {
      sendLog("⚠️ Bluetooth з'єднано, але ЕБУ ще не відповів (" + getELMStatusStr(myELM327.nb_rx_state) + ")", "warn", "connecting");
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
      DEBUG_PORT.printf("🌐 Wi-Fi ПІДКЛЮЧЕНО (Магнітола Pajero)!\n");
      DEBUG_PORT.printf("IP: %s | RSSI: %d dBm | Free Heap: %d KB\n", ip.c_str(), rssi, (int)(ESP.getFreeHeap() / 1024));
      DEBUG_PORT.printf("========================================\n");
      
      // Sync NTP time for TLS
      configTime(0, 0, "pool.ntp.org", "time.google.com");

      sendLog("🌐 Wi-Fi підключено до '" + String(ssid) + "'! IP: " + ip + " (RSSI: " + String(rssi) + " dBm)", "success", "wifi_connected");
      flushLogsToServer();
      flushBufferToServer(); // Immediately flush any records saved during Android 15s boot
    }
  } else {
    if (wasWifiConnected) {
      wasWifiConnected = false;
      DEBUG_PORT.println("⚠️ Wi-Fi з'єднання втрачено (перехід в офлайн-буфер)!");
    }
    if (millis() - lastWifiRetry > 6000) {
      lastWifiRetry = millis();
      DEBUG_PORT.println("🔄 Спроба підключення до Wi-Fi точки Pajero...");
      WiFi.begin(ssid, password);
    }
  }
}

void setup() {
  DEBUG_PORT.begin(115200);
  delay(300);

  initSpiffsLogging();
  if (spiffsMounted) {
    DEBUG_PORT.println("💾 Flash-пам'ять SPIFFS успішно змонтовано (активний кеш розміру).");
    writeLogToFlash("\n--- [ESP32 BOOT / POWER ON] ---");
  } else {
    DEBUG_PORT.println("⚠️ Помилка монтування SPIFFS");
  }

  DEBUG_PORT.println("\n\n========================================");
  DEBUG_PORT.println("🚗 ESP32 Pajero 4 OBD2 Telemetry Logger");
  DEBUG_PORT.printf("Free Heap: %d KB\n", (int)(ESP.getFreeHeap() / 1024));
  DEBUG_PORT.println("💡 Введіть 'DUMP' у Serial для вивантаження логу з Flash-пам'яті");
  DEBUG_PORT.println("========================================");

  telemetryBuffer.reserve(MAX_BUFFER_SIZE);
  logQueue.reserve(64);

  // 1. Wi-Fi Station Mode with Power Save Disabled (Maximum 2.4 GHz stability on mobile hotspot)
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);
  
  DEBUG_PORT.printf("📡 Ініціалізація Wi-Fi клієнта ('%s')...\n", ssid);
  WiFi.begin(ssid, password);

  // 2. Start Bluetooth Master immediately
  SerialBT.setPin(elmPin);
  ELM_PORT.begin("ESP32-OBD2", true); // Master mode
  DEBUG_PORT.println("📡 Bluetooth Master готовий до з'єднання з 'OBDII'.");
  
  sendLog("🚀 ESP32 успішно завантажено! Очікування старту Android точки доступу та сканера...", "info");
}

void loop() {
  // 0. Process USB Serial debug commands ('DUMP', 'CLEAR')
  if (DEBUG_PORT.available()) {
    String cmd = DEBUG_PORT.readStringUntil('\n');
    cmd.trim();
    if (cmd.equalsIgnoreCase("DUMP") || cmd.equalsIgnoreCase("LOGS") || cmd.equalsIgnoreCase("GET_LOGS") || cmd.equalsIgnoreCase("LOG")) {
      dumpLogsToSerial();
    } else if (cmd.equalsIgnoreCase("CLEAR") || cmd.equalsIgnoreCase("CLEAR_LOGS")) {
      SPIFFS.remove(LOG_FILE_PATH);
      DEBUG_PORT.println("✅ Flash-лог /obd_debug.log успішно очищено.");
    }
  }

  // 1. Monitor Wi-Fi state & handle non-blocking auto-reconnects
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
      float dt = (lastUpdate > 0) ? ((millis() - lastUpdate) / 1000.0) : 1.0;
      lastUpdate = millis();

      float volt = myELM327.batteryVoltage();
      float rpm = myELM327.rpm();
      float speed = myELM327.kph();
      float temp = myELM327.engineCoolantTemp();
      float maf = myELM327.mafRate();

      static int consecutiveErrors = 0;
      static bool engineRunning = false;

      // Handle Engine Off / Sleep on Blue ELM327
      if (myELM327.nb_rx_state != ELM_SUCCESS && (isnan(rpm) || rpm <= 0) && (isnan(volt) || volt <= 0)) {
        consecutiveErrors++;
        updateInterval = 3000; // Throttle polling to 3s when engine is OFF to save car battery
        
        if (consecutiveErrors == 3) {
          sendLog("💤 Запалювання вимкнено (очікування старту двигуна Pajero 4)...", "info", "engine_off");
        }
        if (consecutiveErrors >= 20) {
          sendLog("🔄 Переініціалізація протоколу ELM327...", "warn", "connecting");
          elmInitialized = false;
          consecutiveErrors = 0;
        }
      } else {
        consecutiveErrors = 0;
        updateInterval = 1000; // Normal 1-second active telemetry rate
      }

      if (isnan(volt) || volt < 0 || volt > 30.0) volt = 0;
      if (isnan(rpm) || rpm < 0) rpm = 0;
      if (isnan(speed) || speed < 0) speed = 0;
      if (isnan(temp) || temp < -40 || temp > 200) temp = 0;
      if (isnan(maf) || maf < 0) maf = 0;

      // Fuel consumption for Gasoline (14.7:1 AFR, density ~720 g/L)
      float fuel_rate = (maf > 0) ? (maf * 3600.0 / 14.7 / 720.0) : 0;

      if (rpm > 400 || volt > 13.0) {
        engineRunning = true;
      } else if (rpm == 0 && volt > 0 && volt < 12.8) {
        engineRunning = false;
      }

      if (volt > 0 || rpm > 0 || speed > 0 || temp > 0 || myELM327.nb_rx_state == ELM_SUCCESS) {
        DEBUG_PORT.printf("✅ DATA: RPM: %.0f | Speed: %.0f km/h | Temp: %.0f C | Volt: %.1f V | Fuel: %.1f L/h | Buffer: %d\n", 
                          rpm, speed, temp, volt, fuel_rate, (int)telemetryBuffer.size());
        
        // Save to offline buffer (will be flushed when Android Wi-Fi connects)
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
