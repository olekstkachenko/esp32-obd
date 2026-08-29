#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include "BluetoothSerial.h"
#include <ELMduino.h>

// --- WiFi Credentials ---
const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";

// --- Server Details ---
const char* serverUrl = "http://YOUR_SERVER_IP:3000/api/obd";

BluetoothSerial SerialBT;
#define ELM_PORT SerialBT
#define DEBUG_PORT Serial

ELM327 myELM327;
const char* pin = "1234"; 

unsigned long lastUpdate = 0;
const unsigned long updateInterval = 1000; // 1 second for more granular data

void setupWiFi() {
  DEBUG_PORT.println("Connecting to WiFi...");
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    DEBUG_PORT.print(".");
  }
  DEBUG_PORT.println("\nWiFi connected.");
}

void setup() {
  DEBUG_PORT.begin(115200);
  setupWiFi();

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

void sendDataToServer(float rpm, float speed, float temp, float volt, float fuel) {
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(serverUrl);
    http.addHeader("Content-Type", "application/json");

    String jsonPayload = "{";
    jsonPayload += "\"rpm\":" + String(rpm) + ",";
    jsonPayload += "\"speed\":" + String(speed) + ",";
    jsonPayload += "\"temp\":" + String(temp) + ",";
    jsonPayload += "\"voltage\":" + String(volt) + ",";
    jsonPayload += "\"fuel_rate\":" + String(fuel);
    jsonPayload += "}";
    
    int httpResponseCode = http.POST(jsonPayload);
    http.end();
  }
}

void loop() {
  if (millis() - lastUpdate > updateInterval) {
    lastUpdate = millis();

    // Read all parameters sequentially
    float rpm = myELM327.rpm();
    float speed = myELM327.kph();
    float temp = myELM327.engineCoolantTemp();
    float volt = myELM327.batteryVoltage();
    float maf = myELM327.mafRate(); // g/s

    // Calculate approx Fuel Rate (Liters per Hour) from MAF
    // MAF (g/s) * 3600 (s) / 14.7 (Air-Fuel Ratio) / 717 (gasoline density g/L)
    float fuel_rate = (maf > 0 && myELM327.nb_rx_state == ELM_SUCCESS) ? (maf * 3600.0 / 14.7 / 717.0) : 0;

    if (myELM327.nb_rx_state == ELM_SUCCESS) {
      DEBUG_PORT.printf("RPM: %.0f | Speed: %.0f km/h | Temp: %.0f C | Volt: %.1f V | Fuel: %.1f L/h\n", rpm, speed, temp, volt, fuel_rate);
      sendDataToServer(rpm, speed, temp, volt, fuel_rate);
    } else if (myELM327.nb_rx_state != ELM_GETTING_MSG) {
      DEBUG_PORT.print("ELM327 ERROR: ");
      DEBUG_PORT.println(myELM327.nb_rx_state);
    }
  }
}
