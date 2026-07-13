# ============================================================
# Dockerfile - ZyPage Streamer Scraper
# Deploy-ready for Railway
# ============================================================

FROM node:20-slim

# Cai cac thu vien he thong can thiet cho Playwright / Chromium
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files truoc de cache layer
COPY package*.json ./

# Cai Node packages
RUN npm ci --only=production

# Cai Chromium cho Playwright
RUN npx playwright install --with-deps chromium

# Copy toan bo source code
COPY . .

# Railway tu dong set bien PORT, expose de Railway nhan dien
EXPOSE 3000

# Khoi dong server
CMD ["node", "server.js"]
