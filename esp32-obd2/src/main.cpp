// =========================================================================
// 🚗 ESP32 OBD2 Telemetry Logger for Mitsubishi Pajero Wagon 4
// 📡 Dual-Core FreeRTOS Engine: Core 0 (Network/TLS) + Core 1 (OBD2/BT)
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

#include "esp_bt.h"
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

// =========================================================================
// 🛰️ GPS Module Support (UART2: GPIO 16 RX, GPIO 17 TX @ 9600 baud)
// Щоб увімкнути GPS — просто розкоментуйте рядок нижче:
// =========================================================================
// #define ENABLE_GPS 1

#ifdef ENABLE_GPS
#include <TinyGPSPlus.h>
#define GPS_RX_PIN 16
#define GPS_TX_PIN 17
#define GPS_BAUD 9600
HardwareSerial GPS_SERIAL(2);
TinyGPSPlus gps;

void readGps() {
  while (GPS_SERIAL.available() > 0) {
    gps.encode(GPS_SERIAL.read());
  }
}
#endif

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
  spiffsMounted = SPIFFS.begin(true, "/spiffs", 2); // Limit maxOpenFiles to 2 to save heap
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

// --- Thread-Safe Shared Queues & Mutex ---
struct OBDRecord {
  float rpm;
  float speed;
  float temp;
  float volt;
  float fuel;
  float dt;
  float lat;
  float lon;
  float alt;
  int sat;
  bool hasGps;
};

struct LogEntry {
  String message;
  String level;
  String bt_status;
};

static SemaphoreHandle_t dataMutex = NULL;
std::vector<OBDRecord> telemetryBuffer;
const size_t MAX_BUFFER_SIZE = 600; // Store up to ~10-15 minutes of offline telemetry on highway (~14.4 KB RAM)
std::vector<LogEntry> logQueue;

void sendLog(const String& message, const String& level = "info", const String& bt_status = "") {
  String timestampStr = "[" + String(millis() / 1000) + "s] [" + level + "] " + message;
  DEBUG_PORT.println(timestampStr);
  writeLogToFlash(timestampStr);

  LogEntry entry = {message, level, bt_status};
  if (dataMutex) xSemaphoreTake(dataMutex, portMAX_DELAY);
  logQueue.push_back(entry);
  if (logQueue.size() > 20) logQueue.erase(logQueue.begin());
  if (dataMutex) xSemaphoreGive(dataMutex);
}

void clearBluetoothBonds() {
  if (!btStarted()) return;
  int dev_num = esp_bt_gap_get_bond_device_num();
  if (dev_num > 0 && dev_num < 20) {
    esp_bd_addr_t dev_list[dev_num];
    if (esp_bt_gap_get_bond_device_list(&dev_num, dev_list) == ESP_OK) {
      for (int i = 0; i < dev_num; i++) {
        esp_bt_gap_remove_bond_device(dev_list[i]);
      }
    }
  }
}

ELM327 myELM327;
bool elmConnected = false;
bool elmInitialized = false;

#include "esp_http_client.h"
#include "roots.h"

volatile bool isBtConnecting = false;

// =========================================================================
// 🚀 Dual-Mode High-Speed HTTP/HTTPS POST Handler
// =========================================================================
bool sendHttpPost(const String& url, const String& jsonPayload, int& outCode) {
  if (WiFi.status() != WL_CONNECTED) {
    outCode = -99;
    return false;
  }

  bool isHttps = url.startsWith("https://");

  // Prevent RAM collision ONLY for heavy HTTPS if Bluetooth is actively negotiating connection AND heap is low
  if (isHttps && isBtConnecting && ESP.getFreeHeap() < 30000) {
    DEBUG_PORT.printf("⏳ [HTTP Deferred] BT Connecting (%d) | Free Heap: %d KB\n", isBtConnecting, (int)(ESP.getFreeHeap() / 1024));
    outCode = -2;
    return false;
  }

  if (isHttps) {
    WiFiClientSecure secClient;
    secClient.setInsecure();
    secClient.setTimeout(8000);

    HTTPClient http;
    http.setTimeout(8000);
    http.setReuse(false);

    if (!http.begin(secClient, url)) {
      DEBUG_PORT.printf("❌ [HTTP HTTPS] begin failed for: %s | Free RAM: %d KB\n", url.c_str(), (int)(ESP.getFreeHeap() / 1024));
      outCode = -1;
      return false;
    }

    http.addHeader("Content-Type", "application/json");
    http.addHeader("User-Agent", "ESP32-OBD2-Pajero4");
    http.addHeader("ngrok-skip-browser-warning", "true");

    outCode = http.POST(jsonPayload);
    DEBUG_PORT.printf("📡 [HTTP HTTPS] Code: %d (%s) | Free RAM: %d KB (MaxBlock: %d KB)\n", 
                      outCode, http.errorToString(outCode).c_str(), (int)(ESP.getFreeHeap() / 1024), (int)(ESP.getMaxAllocHeap() / 1024));
    http.end();
    secClient.stop();
  } else {
    // Ultra-Fast Plain HTTP for In-Car Hotspot Local Connection (0 KB Crypto Overhead!)
    HTTPClient http;
    http.setTimeout(5000);
    http.setReuse(false);

    WiFiClient client;
    client.setTimeout(5000);

    if (!http.begin(client, url)) {
      DEBUG_PORT.printf("❌ [HTTP Plain] begin failed for: %s | Free RAM: %d KB\n", url.c_str(), (int)(ESP.getFreeHeap() / 1024));
      outCode = -1;
      return false;
    }

    http.setFollowRedirects(HTTPC_FORCE_FOLLOW_REDIRECTS);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("User-Agent", "ESP32-OBD2-Pajero4");
    http.addHeader("ngrok-skip-browser-warning", "true");

    outCode = http.POST(jsonPayload);
    DEBUG_PORT.printf("📡 [HTTP Plain] Code: %d (%s) | Free RAM: %d KB (MaxBlock: %d KB)\n", 
                      outCode, http.errorToString(outCode).c_str(), (int)(ESP.getFreeHeap() / 1024), (int)(ESP.getMaxAllocHeap() / 1024));
    http.end();
  }

  return (outCode >= 200 && outCode < 300);
}

void flushLogsToServer() {
  if (WiFi.status() != WL_CONNECTED) return;

  String baseUrl = String(serverUrlBase);
  int idx = baseUrl.indexOf("/api/obd");
  String url = (idx >= 0 ? baseUrl.substring(0, idx) : baseUrl) + "/api/device/log";

  int count = 0;
  while (WiFi.status() == WL_CONNECTED && count < 5) {
    LogEntry entry;
    bool hasEntry = false;

    if (dataMutex) xSemaphoreTake(dataMutex, portMAX_DELAY);
    if (!logQueue.empty()) {
      entry = logQueue.front();
      hasEntry = true;
    }
    if (dataMutex) xSemaphoreGive(dataMutex);

    if (!hasEntry) break;

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
      if (dataMutex) xSemaphoreTake(dataMutex, portMAX_DELAY);
      if (!logQueue.empty()) logQueue.erase(logQueue.begin());
      if (dataMutex) xSemaphoreGive(dataMutex);
      count++;
    } else {
      break;
    }
  }
}

void sendHeartbeat() {
  if (WiFi.status() != WL_CONNECTED) return;

  String baseUrl = String(serverUrlBase);
  int idx = baseUrl.indexOf("/api/obd");
  String url = (idx >= 0 ? baseUrl.substring(0, idx) : baseUrl) + "/api/device/log";

  String btState = elmInitialized ? "connected" : (SerialBT.connected() ? "connecting" : "disconnected");

  String json = "{";
  json += "\"wifi_status\":\"connected\",";
  json += "\"bt_status\":\"" + btState + "\",";
  json += "\"free_heap\":" + String(ESP.getFreeHeap() / 1024) + ",";
  json += "\"rssi\":" + String(WiFi.RSSI()) + ",";
  json += "\"ip\":\"" + WiFi.localIP().toString() + "\"";
  json += "}";

  int code = 0;
  sendHttpPost(url, json, code);
}

const size_t MAX_BATCH_CHUNK = 40; // Safely fit in ESP32 RAM & TLS packet size (~3.5 KB)

void flushBufferToServer() {
  if (WiFi.status() != WL_CONNECTED) return;

  String baseUrl = String(serverUrlBase);
  bool isBatch = false;
  
  if (dataMutex) xSemaphoreTake(dataMutex, portMAX_DELAY);
  size_t bufSize = telemetryBuffer.size();
  isBatch = (bufSize > 1);
  if (dataMutex) xSemaphoreGive(dataMutex);

  if (bufSize == 0) return;

  String url = isBatch ? (baseUrl + "/batch") : baseUrl;

  if (bufSize == 1) {
    OBDRecord r;
    if (dataMutex) xSemaphoreTake(dataMutex, portMAX_DELAY);
    if (!telemetryBuffer.empty()) r = telemetryBuffer[0];
    if (dataMutex) xSemaphoreGive(dataMutex);

    String jsonPayload;
    jsonPayload.reserve(192);
    jsonPayload = "{";
    jsonPayload += "\"rpm\":" + String(r.rpm, 1) + ",";
    jsonPayload += "\"speed\":" + String(r.speed, 1) + ",";
    jsonPayload += "\"temp\":" + String(r.temp, 1) + ",";
    jsonPayload += "\"voltage\":" + String(r.volt, 1) + ",";
    jsonPayload += "\"fuel_rate\":" + String(r.fuel, 1) + ",";
    jsonPayload += "\"dt\":" + String(r.dt, 2);
    if (r.hasGps) {
      jsonPayload += ",\"lat\":" + String(r.lat, 6);
      jsonPayload += ",\"lon\":" + String(r.lon, 6);
      jsonPayload += ",\"alt\":" + String(r.alt, 1);
      jsonPayload += ",\"sat\":" + String(r.sat);
    }
    jsonPayload += "}";

    int httpCode = 0;
    bool ok = sendHttpPost(url, jsonPayload, httpCode);
    if (ok) {
      if (dataMutex) xSemaphoreTake(dataMutex, portMAX_DELAY);
      telemetryBuffer.clear();
      if (dataMutex) xSemaphoreGive(dataMutex);
      DEBUG_PORT.println("✅ [Buffer Sync] 1 запис успішно відправлено на сервер");
    }
    return;
  }

  // Safe chunked flushing to protect heap from large JSON allocations
  while (WiFi.status() == WL_CONNECTED) {
    size_t currentSize = 0;
    std::vector<OBDRecord> chunk;

    if (dataMutex) xSemaphoreTake(dataMutex, portMAX_DELAY);
    currentSize = telemetryBuffer.size();
    if (currentSize > 0) {
      size_t chunkSize = (currentSize > MAX_BATCH_CHUNK) ? MAX_BATCH_CHUNK : currentSize;
      chunk.assign(telemetryBuffer.begin(), telemetryBuffer.begin() + chunkSize);
    }
    if (dataMutex) xSemaphoreGive(dataMutex);

    if (chunk.empty()) break;

    String jsonPayload;
    jsonPayload.reserve(chunk.size() * 110 + 32);
    jsonPayload = "{\"records\":[";
    for (size_t i = 0; i < chunk.size(); i++) {
      const auto& r = chunk[i];
      if (i > 0) jsonPayload += ",";
      jsonPayload += "{\"rpm\":" + String(r.rpm, 1) +
                     ",\"speed\":" + String(r.speed, 1) +
                     ",\"temp\":" + String(r.temp, 1) +
                     ",\"voltage\":" + String(r.volt, 1) +
                     ",\"fuel_rate\":" + String(r.fuel, 1) +
                     ",\"dt\":" + String(r.dt, 2);
      if (r.hasGps) {
        jsonPayload += ",\"lat\":" + String(r.lat, 6);
        jsonPayload += ",\"lon\":" + String(r.lon, 6);
        jsonPayload += ",\"alt\":" + String(r.alt, 1);
        jsonPayload += ",\"sat\":" + String(r.sat);
      }
      jsonPayload += "}";
    }
    jsonPayload += "]}";

    int httpCode = 0;
    bool ok = sendHttpPost(url, jsonPayload, httpCode);
    if (ok) {
      if (dataMutex) xSemaphoreTake(dataMutex, portMAX_DELAY);
      size_t toErase = (telemetryBuffer.size() >= chunk.size()) ? chunk.size() : telemetryBuffer.size();
      telemetryBuffer.erase(telemetryBuffer.begin(), telemetryBuffer.begin() + toErase);
      size_t remaining = telemetryBuffer.size();
      if (dataMutex) xSemaphoreGive(dataMutex);

      DEBUG_PORT.printf("✅ [Buffer Sync] Відправлено чанк %d записів (Залишок: %d)\n", (int)chunk.size(), (int)remaining);
    } else {
      DEBUG_PORT.printf("⚠️ [Buffer Sync] Збій синхронізації чанку (HTTP %d). Буфер: %d записів\n", httpCode, (int)currentSize);
      break;
    }
  }
}

// =========================================================================
// 🌐 CORE 0 BACKGROUND TASK: Dedicated Wi-Fi, TLS & Telemetry Ingestion
// =========================================================================
static bool wasWifiConnected = false;
static unsigned long lastWifiRetry = 0;
static unsigned long lastLogFlush = 0;
static unsigned long lastHeartbeat = 0;

void networkTask(void *pvParameters) {
  DEBUG_PORT.printf("🌐 [Core 0] Network Task запущено на ядрі %d\n", xPortGetCoreID());
  vTaskDelay(pdMS_TO_TICKS(3000));

  for (;;) {
    // 1. Wi-Fi Connection Management
    if (WiFi.status() == WL_CONNECTED) {
      if (!wasWifiConnected) {
        wasWifiConnected = true;
        String ip = WiFi.localIP().toString();
        int rssi = WiFi.RSSI();
        DEBUG_PORT.printf("\n========================================\n");
        DEBUG_PORT.printf("🌐 Wi-Fi ПІДКЛЮЧЕНО (Магнітола Pajero)!\n");
        DEBUG_PORT.printf("IP: %s | RSSI: %d dBm | Free Heap: %d KB\n", ip.c_str(), rssi, (int)(ESP.getFreeHeap() / 1024));
        DEBUG_PORT.printf("========================================\n");

        configTime(0, 0, "pool.ntp.org", "time.google.com");
        sendLog("🌐 Wi-Fi підключено до '" + String(ssid) + "'! IP: " + ip + " (RSSI: " + String(rssi) + " dBm)", "success", "wifi_connected");
        flushLogsToServer();
        flushBufferToServer();
      }
    } else {
      if (wasWifiConnected) {
        wasWifiConnected = false;
        DEBUG_PORT.println("⚠️ Wi-Fi з'єднання втрачено (перехід в офлайн-буфер)!");
      }
      if (millis() - lastWifiRetry > 10000) {
        lastWifiRetry = millis();
        DEBUG_PORT.println("🔄 Перевірка Wi-Fi з'єднання (WiFi.reconnect)...");
        if (WiFi.status() != WL_CONNECTED) {
          WiFi.reconnect();
        }
      }
    }

    // 2. High-Speed Periodic Telemetry & Log Flushing (every 500ms)
    if (WiFi.status() == WL_CONNECTED && (millis() - lastLogFlush > 500)) {
      lastLogFlush = millis();
      flushLogsToServer();
      flushBufferToServer();
    }

    // 3. Heartbeat (every 3s to maintain continuous Online status)
    if (WiFi.status() == WL_CONNECTED && (millis() - lastHeartbeat > 3000)) {
      lastHeartbeat = millis();
      sendHeartbeat();
    }

    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

// =========================================================================
// 📡 BLUETOOTH ELM327 LOGIC (Runs on Core 1)
// =========================================================================
bool isDummyMac(uint8_t mac[6]) {
  if (mac[0] == 0x00 && mac[1] == 0x00 && mac[2] == 0x00 && mac[3] == 0x00 && mac[4] == 0x00 && mac[5] == 0x00) return true;
  if (mac[0] == 0x00 && mac[1] == 0x00 && mac[2] == 0x00 && mac[3] == 0x33 && mac[4] == 0x33 && mac[5] == 0x33) return true;
  if (mac[0] == 0x02 && mac[1] == 0x00 && mac[2] == 0x00 && mac[3] == 0x00 && mac[4] == 0x00 && mac[5] == 0x00) return true;
  return false;
}

const char* targetNames[] = {"OBDII", "OBD2", "ELM327", "vLinker", "Viecar", "OBD-II"};
const char* pins[] = {"1234", "0000", "6789", "1111", "8888", "123456", ""};

bool connectToELM327() {
  isBtConnecting = true;
  clearBluetoothBonds();
  sendLog("🎬 Перевірка Bluetooth. Вільна пам'ять RAM: " + String(ESP.getFreeHeap() / 1024) + " KB", "info", "connecting");

  // Крок 1: Пряме швидке підключення до імені "OBDII" (PIN: 1234)
  sendLog("📡 [1/2] Пряме з'єднання з сканером '" + String(elmName) + "' (PIN '" + String(elmPin) + "')...", "info", "connecting");
  SerialBT.setPin(elmPin);
  if (SerialBT.connect(elmName)) {
    sendLog("🎉 УСПІХ! З'єднано по Bluetooth з сканером '" + String(elmName) + "'!", "success", "connected");
    isBtConnecting = false;
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
      isBtConnecting = false;
      return true;
    }
  }

  // Крок 3: Періодичне сканування ефіру (раз на 30 секунд)
  static unsigned long lastScanTime = 0;
  if (millis() - lastScanTime > 30000) {
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
              isBtConnecting = false;
              return true;
            }
          }
        }
      }
    }
  }

  isBtConnecting = false;
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

static unsigned long lastELMRetry = 0;

void ensureELMConnected() {
  if (!SerialBT.connected()) {
    elmConnected = false;
    elmInitialized = false;
    
    if (millis() - lastELMRetry > 15000) {
      if (connectToELM327()) {
        elmConnected = true;
      }
      lastELMRetry = millis();
    }
    return;
  }

  static unsigned long lastELMInitAttempt = 0;
  if (elmConnected && !elmInitialized) {
    if (millis() - lastELMInitAttempt > 8000) {
      lastELMInitAttempt = millis();
      sendLog("⚙️ Bluetooth з'єднання є! Ініціалізуємо протокол Pajero 4 CAN...", "info", "connecting");
      if (myELM327.begin(ELM_PORT, false, 2500)) {
        sendLog("🚀 УСПІХ! Протокол ELM327 зв'язано з ЕБУ Pajero 4! Почався збір даних.", "success", "connected");
        elmInitialized = true;
      } else {
        sendLog("⚠️ Bluetooth з'єднано, але ЕБУ ще не відповів (" + getELMStatusStr(myELM327.nb_rx_state) + ")", "warn", "connecting");
      }
    }
  }
}

// =========================================================================
// 🚀 ARDUINO SETUP & LOOP (Runs on Core 1)
// =========================================================================
unsigned long lastUpdate = 0;
unsigned long updateInterval = 1000;

void setup() {
  DEBUG_PORT.begin(115200);
  delay(300);

  dataMutex = xSemaphoreCreateMutex();

  initSpiffsLogging();
  if (spiffsMounted) {
    DEBUG_PORT.println("💾 Flash-пам'ять SPIFFS успішно змонтовано (активний кеш розміру).");
    writeLogToFlash("\n--- [ESP32 BOOT / POWER ON] ---");
  } else {
    DEBUG_PORT.println("⚠️ Помилка монтування SPIFFS");
  }

  DEBUG_PORT.println("\n\n========================================");
  DEBUG_PORT.println("🚗 ESP32 Pajero 4 OBD2 Telemetry Logger");
  DEBUG_PORT.printf("Free Heap: %d KB | Max Contiguous Block: %d KB\n", (int)(ESP.getFreeHeap() / 1024), (int)(ESP.getMaxAllocHeap() / 1024));
  DEBUG_PORT.println("💡 Введіть 'DUMP' у Serial для вивантаження логу з Flash-пам'яті");
  DEBUG_PORT.println("========================================");

  telemetryBuffer.reserve(30);
  logQueue.reserve(10);

  // Release BLE controller RAM before starting Bluetooth Classic (frees ~30 KB for TLS)
  esp_bt_controller_mem_release(ESP_BT_MODE_BLE);

  // 1. Start Bluetooth Master (Must be started before Wi-Fi for RF coexistence coex_enable)
  if (ELM_PORT.begin("ESP32-OBD2", true)) {
    SerialBT.setPin(elmPin);
    DEBUG_PORT.println("📡 Bluetooth Master готовий до з'єднання з 'OBDII'.");
  } else {
    DEBUG_PORT.println("⚠️ Помилка ініціалізації Bluetooth Master!");
  }

  // 2. Wi-Fi Station Mode Configuration (Modem Sleep MUST be true for WiFi/BT coexistence)
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(true);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);
  
  DEBUG_PORT.printf("📡 Підключення до Wi-Fi точки '%s'...\n", ssid);
  WiFi.begin(ssid, password);

  // 3. Launch Dedicated Network Task on Core 0 (Completely non-blocking, 10KB stack for TLS)
  xTaskCreatePinnedToCore(
    networkTask,
    "NetworkTask",
    10240,
    NULL,
    1,
    NULL,
    0 // Core 0
  );
  
#ifdef ENABLE_GPS
  // 4. Start Hardware GPS Module on UART2 (GPIO 16 RX, GPIO 17 TX)
  GPS_SERIAL.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  DEBUG_PORT.println("🛰️ GPS UART2 ініціалізовано (GPIO 16 RX, GPIO 17 TX @ 9600)");
#endif

  sendLog("🚀 ESP32 успішно завантажено! Очікування старту точки доступу та сканера...", "info");
}

void loop() {
#ifdef ENABLE_GPS
  // Continuous non-blocking NMEA GPS parser
  readGps();
#endif

  // 0. Process USB Serial debug commands ('DUMP', 'CLEAR', 'STATUS', 'REBOOT', 'HELP')
  if (DEBUG_PORT.available()) {
    String cmd = DEBUG_PORT.readStringUntil('\n');
    cmd.trim();
    if (cmd.equalsIgnoreCase("DUMP") || cmd.equalsIgnoreCase("LOGS") || cmd.equalsIgnoreCase("GET_LOGS") || cmd.equalsIgnoreCase("LOG")) {
      dumpLogsToSerial();
    } else if (cmd.equalsIgnoreCase("CLEAR") || cmd.equalsIgnoreCase("CLEAR_LOGS")) {
      SPIFFS.remove(LOG_FILE_PATH);
      currentFlashLogBytes = 0;
      DEBUG_PORT.println("✅ Flash-лог /obd_debug.log успішно очищено.");
    } else if (cmd.equalsIgnoreCase("STATUS") || cmd.equalsIgnoreCase("INFO") || cmd.equalsIgnoreCase("STATE")) {
      DEBUG_PORT.println("\n--- [ESP32 DIAGNOSTIC STATUS] ---");
      DEBUG_PORT.printf("Free Heap: %d KB\n", (int)(ESP.getFreeHeap() / 1024));
      DEBUG_PORT.printf("Wi-Fi: %s (IP: %s | RSSI: %d dBm)\n", (WiFi.status() == WL_CONNECTED ? "CONNECTED" : "OFFLINE"), WiFi.localIP().toString().c_str(), WiFi.RSSI());
      DEBUG_PORT.printf("Bluetooth: %s | ELM Init: %s\n", (SerialBT.connected() ? "CONNECTED" : "DISCONNECTED"), (elmInitialized ? "YES" : "NO"));
#ifdef ENABLE_GPS
      DEBUG_PORT.printf("GPS Fix: %s (Sats: %d | Lat: %.5f, Lon: %.5f)\n", (gps.location.isValid() ? "YES" : "NO"), (int)gps.satellites.value(), gps.location.lat(), gps.location.lng());
#else
      DEBUG_PORT.println("GPS: ВИМКНЕНО (закоментовано в прошивці)");
#endif
      DEBUG_PORT.printf("Telemetry Buffer: %d records\n", (int)telemetryBuffer.size());
      DEBUG_PORT.printf("Flash Log: %d / %d bytes\n", (int)currentFlashLogBytes, (int)MAX_LOG_FILE_BYTES);
      DEBUG_PORT.println("---------------------------------\n");
    } else if (cmd.equalsIgnoreCase("REBOOT") || cmd.equalsIgnoreCase("RESTART")) {
      DEBUG_PORT.println("🔄 Перезавантаження ESP32 за командою...");
      delay(500);
      ESP.restart();
    } else if (cmd.equalsIgnoreCase("HELP") || cmd.equalsIgnoreCase("?")) {
      DEBUG_PORT.println("\n--- [ДОСТУПНІ КОМАНДИ SERIAL] ---");
      DEBUG_PORT.println("DUMP    - Вивантажити всі логи з Flash-пам'яті SPIFFS");
      DEBUG_PORT.println("CLEAR   - Очистити файл логів у Flash-пам'яті");
      DEBUG_PORT.println("STATUS  - Показати стан зв'язку, GPS, пам'ять RAM та буфер");
      DEBUG_PORT.println("REBOOT  - Перезавантажити ESP32");
      DEBUG_PORT.println("---------------------------------\n");
    }
  }

  // 1. Maintain Bluetooth OBD2 connection
  ensureELMConnected();

  enum ObdQueryState {
    STATE_RPM,
    STATE_SPEED,
    STATE_COOLANT,
    STATE_VOLT
  };

  static ObdQueryState obdState = STATE_RPM;
  static float liveRpm = 0.0f;
  static float liveSpeed = 0.0f;
  static float liveTemp = 0.0f;
  static float liveVolt = 0.0f;
  static float liveFuel = 0.0f;

  static unsigned long lastPushTime = 0;
  static unsigned long lastSlowQuery = 0;
  static bool engineRunning = false;
  static bool ignitionLogged = false;

  // 2. Query OBD2 telemetry via non-blocking state machine
  if (elmInitialized && SerialBT.connected()) {
    switch (obdState) {
      case STATE_RPM: {
        float r = myELM327.rpm();
        if (myELM327.nb_rx_state == ELM_SUCCESS) {
          if (!isnan(r) && r >= 0 && r <= 8000.0f) {
            liveRpm = r;
          }
          obdState = STATE_SPEED;
        } else if (myELM327.nb_rx_state != ELM_GETTING_MSG) {
          liveRpm = 0.0f;
          obdState = STATE_SPEED;
        }
        break;
      }

      case STATE_SPEED: {
        int32_t raw_s = myELM327.kph();
        if (myELM327.nb_rx_state == ELM_SUCCESS) {
          // Standard OBD-II PID 010D returns vehicle speed directly in km/h (0-255 km/h)
          float s = (float)raw_s;
          
          // Pajero 4 physical cap: 185 km/h. Discard ELM327 artifacts
          if (s >= 0.0f && s <= 185.0f) {
            // Delta-V glitch protection: ignore instant acceleration jump > 35 km/h per second
            if (liveSpeed <= 0.0f || s <= liveSpeed || (s - liveSpeed) <= 35.0f) {
              liveSpeed = s;
            }
          }
          // Prioritize coolant/voltage when engine is stopped, or query every 2.5s while driving
          if (!engineRunning || (millis() - lastSlowQuery > 2500)) {
            obdState = STATE_COOLANT;
          } else {
            obdState = STATE_RPM;
          }
        } else if (myELM327.nb_rx_state != ELM_GETTING_MSG) {
          liveSpeed = 0.0f;
          if (!engineRunning || (millis() - lastSlowQuery > 2500)) {
            obdState = STATE_COOLANT;
          } else {
            obdState = STATE_RPM;
          }
        }
        break;
      }

      case STATE_COOLANT: {
        float t = myELM327.engineCoolantTemp();
        if (myELM327.nb_rx_state == ELM_SUCCESS) {
          if (!isnan(t) && t > -40.0f && t < 150.0f) {
            liveTemp = t;
          }
          obdState = STATE_VOLT;
        } else if (myELM327.nb_rx_state != ELM_GETTING_MSG) {
          obdState = STATE_VOLT;
        }
        break;
      }

      case STATE_VOLT: {
        float v = myELM327.batteryVoltage();
        if (myELM327.nb_rx_state == ELM_SUCCESS) {
          if (!isnan(v) && v > 5.0f && v < 20.0f) {
            liveVolt = v;
          }
          lastSlowQuery = millis();
          obdState = STATE_RPM;
        } else if (myELM327.nb_rx_state != ELM_GETTING_MSG) {
          lastSlowQuery = millis();
          obdState = STATE_RPM;
        }
        break;
      }
    }

    // 3. Periodic Telemetry Commit & Buffer Push
    // Interval: 500ms when driving, 1000ms when engine stopped / ignition standby
    unsigned long pushInterval = engineRunning ? 500 : 1000;

    if (millis() - lastPushTime >= pushInterval) {
      unsigned long nowMs = millis();
      float dt = (lastPushTime > 0) ? ((nowMs - lastPushTime) / 1000.0f) : (pushInterval / 1000.0f);
      lastPushTime = nowMs;
      if (dt < 0.1f || dt > 3.0f) dt = (pushInterval / 1000.0f);

      // Check engine state transitions
      if (liveRpm > 350.0f || liveSpeed > 2.0f) {
        if (!engineRunning) {
          engineRunning = true;
          ignitionLogged = false;
          sendLog("🚗 Двигун запущено (" + String((int)liveRpm) + " RPM)! Початок поїздки Pajero 4.", "success", "engine_on");
        }
      } else {
        if (engineRunning) {
          engineRunning = false;
          sendLog("🅿️ Двигун зупинено (Запалювання увімкнено | АКБ: " + String(liveVolt, 1) + "V | Темп: " + String(liveTemp, 0) + "°C)", "info", "engine_off");
        } else if (!ignitionLogged) {
          ignitionLogged = true;
          sendLog("🔋 Запалювання / Режим очікування (АКБ: " + String(liveVolt, 1) + "V | Темп: " + String(liveTemp, 0) + "°C)", "info", "standby");
        }
      }

      // Accurate Fuel Consumption Model for Pajero 4 V6 Gasoline (Idle ~1.4 L/h, Dynamic Highway/City Load)
      if (liveRpm > 350.0f) {
        if (liveSpeed <= 3.0f) {
          liveFuel = (liveRpm / 700.0f) * 1.4f; // ~1.4 L/h idle at ~700 RPM
        } else {
          float rpmFactor = (liveRpm / 2000.0f);
          float speedRatio = (liveSpeed / 100.0f);
          liveFuel = (rpmFactor * 6.5f) + (speedRatio * speedRatio * 4.5f) + 1.2f;
        }
      } else {
        liveFuel = 0.0f;
      }

      // ALWAYS record & push telemetry while ELM327 is connected!
#ifdef ENABLE_GPS
      bool hasFix = gps.location.isValid() && (gps.location.age() < 5000);
      float curLat = hasFix ? (float)gps.location.lat() : 0.0f;
      float curLon = hasFix ? (float)gps.location.lng() : 0.0f;
      float curAlt = (hasFix && gps.altitude.isValid()) ? (float)gps.altitude.meters() : 0.0f;
      int curSat = gps.satellites.isValid() ? (int)gps.satellites.value() : 0;
#else
      bool hasFix = false;
      float curLat = 0.0f;
      float curLon = 0.0f;
      float curAlt = 0.0f;
      int curSat = 0;
#endif

      DEBUG_PORT.printf("✅ DATA: RPM: %.0f | Speed: %.0f km/h | Temp: %.0f C | Volt: %.1f V | Fuel: %.1f L/h | Buffer: %d\n", 
                        liveRpm, liveSpeed, liveTemp, liveVolt, liveFuel, (int)telemetryBuffer.size());

      if (dataMutex) xSemaphoreTake(dataMutex, portMAX_DELAY);
      if (telemetryBuffer.size() >= MAX_BUFFER_SIZE) {
        telemetryBuffer.erase(telemetryBuffer.begin());
      }
      telemetryBuffer.push_back({liveRpm, liveSpeed, liveTemp, liveVolt, liveFuel, dt, curLat, curLon, curAlt, curSat, hasFix});
      if (dataMutex) xSemaphoreGive(dataMutex);
    }
  }

  delay(10);
}
