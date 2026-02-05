FROM node:25-trixie-slim

WORKDIR /app

COPY package*.json ./
RUN npx playwright install-deps

# Ensure UTF-8 locale so Cyrillic filenames render correctly
RUN apt-get update && apt-get install -y locales && \
    sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen en_US.UTF-8 && \
    update-locale LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 && \
    rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8


RUN mkdir -p /data/queries /data/downloads && \
    chown -R node:node /app /data 

USER node

RUN npm install
RUN npx playwright install firefox

COPY . .

CMD ["node", "index.js"]
