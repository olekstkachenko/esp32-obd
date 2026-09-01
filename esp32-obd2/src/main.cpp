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
const char* serverUrlBase = "https://mankind-comprised-devotion.ngrok-free.dev/api/obd";

// --- ELM327 Bluetooth Target ---
const char* elmName = "OBDII";
const char* elmPin = "1234";

// Target ELM327 MAC Address
uint8_t elmMac[6] = {0x00, 0x00, 0x00, 0x33, 0x33, 0x33};

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
  }
}

void sendLog(String message, String level = "info", String bt_status = "") {
  DEBUG_PORT.println("[" + level + "] " + message);

  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    String baseUrl = String(serverUrlBase);
    int idx = baseUrl.indexOf("/api/obd");
    String url = (idx >= 0 ? baseUrl.substring(0, idx) : baseUrl) + "/api/device/log";

    if (url.startsWith("https")) {
      WiFiClientSecure *client = new WiFiClientSecure;
      client->setInsecure();
      http.begin(*client, url);
    } else {
      http.begin(url);
    }

    http.addHeader("Content-Type", "application/json");
    http.addHeader("ngrok-skip-browser-warning", "true");

    String cleanMsg = message;
    cleanMsg.replace("\"", "'");

    String json = "{";
    json += "\"message\":\"" + cleanMsg + "\",";
    json += "\"level\":\"" + level + "\"";
    if (bt_status.length() > 0) {
      json += ",\"bt_status\":\"" + bt_status + "\"";
    }
    json += "}";

    http.POST(json);
    http.end();
  }
}

void flushBufferToServer() {
  if (telemetryBuffer.empty()) return;
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = String(serverUrlBase);
  if (telemetryBuffer.size() > 1) url += "/batch";

  if (url.startsWith("https")) {
    WiFiClientSecure *client = new WiFiClientSecure;
    client->setInsecure();
    http.begin(*client, url);
  } else {
    http.begin(url);
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("ngrok-skip-browser-warning", "true");

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

  int httpCode = http.POST(jsonPayload);
  if (httpCode == 200 || httpCode == 201) {
    DEBUG_PORT.printf("✅ Flushed %d offline records to server (HTTP %d)\n", (int)telemetryBuffer.size(), httpCode);
    telemetryBuffer.clear();
  } else {
    DEBUG_PORT.printf("⚠️ Sync failed (HTTP %d). Buffer size: %d records\n", httpCode, (int)telemetryBuffer.size());
  }
  http.end();
}

bool elmConnected = false;
bool elmInitialized = false;

bool connectToELM327() {
  bool hasMac = (elmMac[0] != 0 || elmMac[1] != 0 || elmMac[2] != 0 || elmMac[3] != 0 || elmMac[4] != 0 || elmMac[5] != 0);

  if (hasMac) {
    char macStr[18];
    snprintf(macStr, sizeof(macStr), "%02X:%02X:%02X:%02X:%02X:%02X", elmMac[0], elmMac[1], elmMac[2], elmMac[3], elmMac[4], elmMac[5]);
    sendLog("📡 Спроба з'єднання за MAC-адресою: " + String(macStr) + " (PIN " + String(elmPin) + ")...", "info", "connecting");
    
    SerialBT.setPin(elmPin);
    if (SerialBT.connect(elmMac)) {
      sendLog("✅ УСПІХ! З'єднано з OBD2 сканером за MAC [" + String(macStr) + "]!", "success", "connected");
      return true;
    }
  }

  sendLog("📡 Спроба з'єднання за ім'ям '" + String(elmName) + "' (PIN " + String(elmPin) + ")...", "info", "connecting");
  SerialBT.setPin(elmPin);
  
  if (SerialBT.connect(elmName)) {
    sendLog("✅ УСПІХ! З'єднано з OBD2 сканером '" + String(elmName) + "'!", "success", "connected");
    return true;
  }

  // If name fails with 1234, try PIN 0000
  SerialBT.setPin("0000");
  if (SerialBT.connect(elmName)) {
    sendLog("✅ УСПІХ! З'єднано з OBD2 сканером '" + String(elmName) + "' (PIN 0000)!", "success", "connected");
    return true;
  }

  sendLog("⚠️ Не вдалося підключитися до '" + String(elmName) + "'. Скануємо пристрої поблизу...", "warn", "scanning");

  // Perform a 3-second Bluetooth discovery scan
  BTScanResults *pResults = SerialBT.getScanResults();
  if (SerialBT.discover(3000)) {
    pResults = SerialBT.getScanResults();
    int count = pResults ? pResults->getCount() : 0;
    sendLog("🔍 Знайдено " + String(count) + " Bluetooth пристроїв поблизу:", "info", "scanning");

    for (int i = 0; i < count; i++) {
      BTAdvertisedDevice *dev = pResults->getDevice(i);
      String devName = String(dev->getName().c_str());
      String devAddr = String(dev->getAddress().toString().c_str());
      sendLog("📱 Пристрій #" + String(i+1) + ": " + (devName.length() > 0 ? devName : "Без імені") + " [" + devAddr + "]", "info", "scanning");
    }
  } else {
    sendLog("❌ Bluetooth пристроїв поблизу не виявлено.", "error", "disconnected");
  }

  return false;
}

void ensureELMConnected() {
  if (!SerialBT.connected()) {
    elmConnected = false;
    elmInitialized = false;
    
    if (millis() - lastELMRetry > 6000) { // Retry every 6 seconds
      lastELMRetry = millis();
      if (connectToELM327()) {
        elmConnected = true;
      }
    }
    return;
  }

  if (elmConnected && !elmInitialized) {
    sendLog("⚙️ З'єднання є! Ініціалізуємо протокол ELM327...", "info", "connecting");
    if (myELM327.begin(ELM_PORT, true, 2000)) {
      sendLog("🚀 ELM327 ініціалізовано! Дані зчитано успішно.", "success", "connected");
      elmInitialized = true;
    } else {
      sendLog("⚠️ ELM327 begin() не відповів, повтор через 2с...", "warn", "connecting");
    }
  }
}

void setup() {
  DEBUG_PORT.begin(115200);
  startWiFi();

  SerialBT.setPin(elmPin);
  ELM_PORT.begin("ESP32-OBD2", true); // Master mode
  DEBUG_PORT.println("Bluetooth Master mode ready.");
}

void loop() {
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
