#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include "BluetoothSerial.h"
#include <ELMduino.h>
#include <WiFiClientSecure.h>
#include <vector>

// --- WiFi Credentials ---
const char* ssid = "Xiaomi 12T Pro";
const char* password = "090384wifi";

// --- Server Details ---
const char* serverUrlBase = "https://mankind-comprised-devotion.ngrok-free.dev/api/obd";

BluetoothSerial SerialBT;
#define ELM_PORT SerialBT
#define DEBUG_PORT Serial

ELM327 myELM327;
const char* pin = "1234"; 

unsigned long lastUpdate = 0;
const unsigned long updateInterval = 1000; // 1 second
unsigned long lastWifiRetry = 0;

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

void flushBufferToServer() {
  if (telemetryBuffer.empty()) return;
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = String(serverUrlBase);
  
  if (telemetryBuffer.size() > 1) {
    url += "/batch";
  }

  if (url.startsWith("https")) {
    WiFiClientSecure *client = new WiFiClientSecure;
    client->setInsecure(); // Skip certificate validation for ngrok/self-signed
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

void setup() {
  DEBUG_PORT.begin(115200);
  startWiFi();

  SerialBT.setPin(pin);
  ELM_PORT.begin("ESP32-OBD2", true); 

  DEBUG_PORT.println("Connecting to ELM327...");
  if (!ELM_PORT.connect("OBDII")) {
    DEBUG_PORT.println("Couldn't connect to OBD scanner");
    while (1) delay(100);
  }

  if (!myELM327.begin(ELM_PORT, true, 2000)) {
    DEBUG_PORT.println("Couldn't initialize ELM327.");
    while (1) delay(100);
  }
  DEBUG_PORT.println("ELM327 initialized.");
}

void loop() {
  // Re-check WiFi connection every 10 seconds if disconnected
  if (WiFi.status() != WL_CONNECTED && (millis() - lastWifiRetry > 10000)) {
    lastWifiRetry = millis();
    DEBUG_PORT.println("Retrying WiFi connection...");
    WiFi.begin(ssid, password);
  }

  if (millis() - lastUpdate > updateInterval) {
    float dt = (millis() - lastUpdate) / 1000.0;
    lastUpdate = millis();

    float rpm = myELM327.rpm();
    float speed = myELM327.kph();
    float temp = myELM327.engineCoolantTemp();
    float volt = myELM327.batteryVoltage();
    float maf = myELM327.mafRate(); // g/s

    float fuel_rate = (maf > 0 && myELM327.nb_rx_state == ELM_SUCCESS) ? (maf * 3600.0 / 14.7 / 717.0) : 0;

    if (myELM327.nb_rx_state == ELM_SUCCESS) {
      DEBUG_PORT.printf("RPM: %.0f | Speed: %.0f km/h | Temp: %.0f C | Volt: %.1f V | Fuel: %.1f L/h | Buffer: %d\n", 
                        rpm, speed, temp, volt, fuel_rate, (int)telemetryBuffer.size());
      
      // Store in buffer
      if (telemetryBuffer.size() >= MAX_BUFFER_SIZE) {
        telemetryBuffer.erase(telemetryBuffer.begin()); // FIFO drop oldest if buffer is full
      }
      telemetryBuffer.push_back({rpm, speed, temp, volt, fuel_rate, dt});

      // Try flushing buffer if WiFi is connected
      if (WiFi.status() == WL_CONNECTED) {
        flushBufferToServer();
      }
    } else if (myELM327.nb_rx_state != ELM_GETTING_MSG) {
      DEBUG_PORT.print("ELM327 ERROR: ");
      DEBUG_PORT.println(myELM327.nb_rx_state);
    }
  }
}
