# Node + Playwright/Chromium in één image, zodat de headless browser altijd
# alle benodigde systeem-libraries heeft (dit is de lastigste stap als je dit
# los probeert te installeren op een "kale" Node-omgeving).
FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

# Installeert Chromium zelf én alle OS-dependencies die het nodig heeft.
RUN npx playwright install --with-deps chromium

COPY . .

ENV NODE_ENV=production
EXPOSE 10000

CMD ["node", "server.js"]
