ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:latest
FROM ${BUILD_FROM}

# Install Node.js, NPM, SQLite, and essential build tools via Alpine package manager
RUN apk add --no-cache \
    nodejs \
    npm \
    curl \
    jq \
    bash \
    sqlite \
    python3 \
    make \
    g++

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
