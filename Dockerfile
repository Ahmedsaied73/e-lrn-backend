FROM node:22-alpine

# dumb-init forwards OS signals (SIGTERM/SIGINT) directly to Node for graceful shutdown.
# Prisma engines require OpenSSL (musl) and libc6-compat at runtime on Alpine.
RUN apk add --no-cache openssl libc6-compat dumb-init wget

WORKDIR /usr/src/app

# Install production dependencies
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --omit=dev --no-audit --no-fund

# Generate Prisma client for linux-musl-openssl-3.0.x
RUN npx prisma generate

# Copy application source code
COPY . .

# Set ownership to unprivileged node user
RUN chown -R node:node /usr/src/app

# Switch to non-root user
USER node

# Expose API port
EXPOSE 3005

# Process-level healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3005/healthz || exit 1

# dumb-init as PID 1 ensures clean signal handling and zombie process reaping
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "app.js"]
