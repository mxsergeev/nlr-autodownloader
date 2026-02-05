FROM node:25-trixie-slim

WORKDIR /app

COPY package*.json ./
RUN npx playwright install-deps

RUN mkdir -p /data/queries /data/downloads && \
    chown -R node:node /app /data 

USER node

RUN npm install
RUN npx playwright install firefox

COPY . .

CMD ["node", "index.js"]
