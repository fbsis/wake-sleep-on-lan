FROM node:18-slim

# Install ping for status checks and sqlite3 for Nginx Proxy Manager discovery
RUN apt-get update \
  && apt-get install -y --no-install-recommends iputils-ping sqlite3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY src ./src

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "src/server.js"]
