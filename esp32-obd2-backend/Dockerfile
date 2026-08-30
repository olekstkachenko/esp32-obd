FROM node:20-alpine

# Install curl for container health check
RUN apk add --no-cache curl

# Create app directory
WORKDIR /usr/src/app

# Force Node.js to prioritize IPv4 to prevent hanging DNS resolution on Alpine Linux
ENV NODE_OPTIONS="--dns-result-order=ipv4first"
ENV NODE_ENV=production

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy application source code
COPY . .

# Create persistent data directory
RUN mkdir -p /usr/src/app/data

# Declare volume for persistent data
VOLUME ["/usr/src/app/data"]

EXPOSE 3000

# Container Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD [ "npm", "start" ]
