ARG BUILD_FROM=node:20-alpine
FROM ${BUILD_FROM}

# Install necessary system utilities
RUN apk add --no-cache \
    curl \
    jq \
    bash \
    sqlite

# Create app directory
WORKDIR /usr/src/app

# Force Node.js to prioritize IPv4 to prevent hanging DNS resolution on Alpine Linux
ENV NODE_OPTIONS="--dns-result-order=ipv4first"
ENV NODE_ENV=production

# Copy dependency definitions
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy application source code
COPY . .

# Set execution rights for run script
RUN chmod a+x run.sh

# Data volume for Home Assistant
VOLUME ["/data"]

EXPOSE 3000

CMD [ "./run.sh" ]
