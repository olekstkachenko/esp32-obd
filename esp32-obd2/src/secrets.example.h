#ifndef SECRETS_EXAMPLE_H
#define SECRETS_EXAMPLE_H

// =======================================================
// 📋 Template Configuration
// Copy this file to "secrets.h" and insert your credentials
// =======================================================

// --- Wi-Fi Credentials ---
#define SECRET_WIFI_SSID "MyCar_WiFi"
#define SECRET_WIFI_PASSWORD "your_wifi_password"

// --- Server Details ---
#define SECRET_SERVER_URL "https://your-domain.ngrok-free.app/api/obd"

// --- ELM327 Bluetooth Scanner Configuration ---
#define SECRET_ELM_NAME "OBDII"
#define SECRET_ELM_PIN "1234"
#define SECRET_ELM_MAC {0x00, 0x00, 0x00, 0x33, 0x33, 0x33}

#endif // SECRETS_EXAMPLE_H
