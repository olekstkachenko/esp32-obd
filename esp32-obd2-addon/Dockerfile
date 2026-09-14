ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:latest
FROM ${BUILD_FROM}

# Install Node.js, NPM, SQLite, Bash, Curl, Tar and build tools
RUN apk add --no-cache \
    nodejs \
    npm \
    curl \
    jq \
    bash \
    sqlite \
    python3 \
    make \
    g++ \
    tar

# Download and install official Ngrok binary matching target CPU architecture
RUN ARCH=$(uname -m) && \
    case "${ARCH}" in \
        x86_64) NGROK_ARCH="amd64" ;; \
        aarch64) NGROK_ARCH="arm64" ;; \
        armv7l|armhf) NGROK_ARCH="arm" ;; \
        i386|i686) NGROK_ARCH="386" ;; \
        *) NGROK_ARCH="amd64" ;; \
    esac && \
    curl -sSL "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-${NGROK_ARCH}.tgz" -o /tmp/ngrok.tgz && \
    tar -xzf /tmp/ngrok.tgz -C /usr/local/bin && \
    rm -f /tmp/ngrok.tgz && \
    chmod +x /usr/local/bin/ngrok

# Create app directory
WORKDIR /usr/src/app

# Force Node.js to prioritize IPv4 to prevent hanging DNS resolution on Alpine Linux
ENV NODE_OPTIONS="--dns-result-order=ipv4first"
ENV NODE_ENV=production

# Copy dependency definitions
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production || npm install --omit=dev

# Copy application source code
COPY . .

# Set execution rights for run script
RUN chmod a+x run.sh

# Data volume for Home Assistant
VOLUME ["/data"]

EXPOSE 3000

CMD [ "./run.sh" ]
