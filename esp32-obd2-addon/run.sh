#!/usr/bin/env bash
set -e

echo "========================================================="
echo "  🚗 ESP32 OBD2 Telemetry Server & Telegram WebApp"
echo "  🏠 Running inside Home Assistant Add-on Environment"
echo "========================================================="

CONFIG_PATH=/data/options.json

if [ -f "$CONFIG_PATH" ]; then
    echo "📄 Reading Home Assistant configuration from $CONFIG_PATH..."
    if command -v jq >/dev/null 2>&1; then
        PORT=$(jq -r '.port // 3000' $CONFIG_PATH)
        echo "🔹 Configured Port: $PORT"
    fi
else
    echo "ℹ️ Running with default environment settings."
fi

# Ensure persistent data directory exists
mkdir -p /data

# Set persistent SQLite database path
export DB_PATH=/data/obd_data.db
export NODE_ENV=production

echo "💾 Persistent DB Path: $DB_PATH"
echo "🚀 Starting Node.js backend..."

exec node server.js
