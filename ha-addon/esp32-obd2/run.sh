#!/usr/bin/env bash
set -e

echo "========================================================="
echo "  🚗 ESP32 OBD2 Telemetry Server & Telegram WebApp"
echo "  🏠 Running inside Home Assistant Add-on Environment"
echo "========================================================="

CONFIG_PATH=/data/options.json
NGROK_AUTHTOKEN=""
NGROK_DOMAIN=""

if [ -f "$CONFIG_PATH" ]; then
    echo "📄 Reading Home Assistant configuration from $CONFIG_PATH..."
    if command -v jq >/dev/null 2>&1; then
        PORT=$(jq -r '.port // 3000' "$CONFIG_PATH")
        RAW_AUTHTOKEN=$(jq -r '.ngrok_authtoken // empty' "$CONFIG_PATH")
        RAW_DOMAIN=$(jq -r '.ngrok_domain // empty' "$CONFIG_PATH")
        
        # Clean token and domain from quotes, protocols, and trailing slashes
        NGROK_AUTHTOKEN=$(echo "$RAW_AUTHTOKEN" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
        NGROK_DOMAIN=$(echo "$RAW_DOMAIN" | sed -e 's|^https://||' -e 's|^http://||' -e 's|/$||' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
        
        echo "🔹 Configured Port: $PORT"
    fi
fi

# Ensure persistent data directory exists
mkdir -p /data

# Set persistent SQLite database path
export DB_PATH=/data/obd_data.db
export NODE_ENV=production

echo "💾 Persistent DB Path: $DB_PATH"

# Launch Ngrok background tunnel if authtoken is configured
if [ -n "$NGROK_AUTHTOKEN" ] && [ "$NGROK_AUTHTOKEN" != "null" ]; then
    echo "🌐 Setting up Ngrok authentication..."
    export NGROK_AUTHTOKEN="$NGROK_AUTHTOKEN"
    ngrok config add-authtoken "$NGROK_AUTHTOKEN" || true

    if [ -n "$NGROK_DOMAIN" ] && [ "$NGROK_DOMAIN" != "null" ]; then
        echo "🚀 Starting Ngrok tunnel for domain: $NGROK_DOMAIN -> Port 3000..."
        ngrok http --authtoken="$NGROK_AUTHTOKEN" --url="$NGROK_DOMAIN" 3000 --log=stdout &
    else
        echo "🚀 Starting Ngrok tunnel on Port 3000..."
        ngrok http --authtoken="$NGROK_AUTHTOKEN" 3000 --log=stdout &
    fi
else
    echo "ℹ️ Ngrok authtoken not specified. Running in direct local/Ingress mode."
fi

echo "🚀 Starting Node.js backend..."
exec node server.js
