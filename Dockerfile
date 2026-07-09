FROM node:20-slim

RUN apt-get update && apt-get install -y wget gnupg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci
RUN npx playwright install --with-deps chromium

COPY . .

CMD ["node", "server.js"]
