FROM node:18-slim

# Install ping for status checks
RUN apt-get update \
  && apt-get install -y --no-install-recommends iputils-ping \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY src ./src

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "src/server.js"]
