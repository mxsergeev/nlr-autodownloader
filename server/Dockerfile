FROM node:25-trixie-slim
WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers

ARG UID=1000
ARG GID=1000

COPY package*.json ./
RUN npx playwright install-deps
RUN npm install
RUN npx playwright install firefox

COPY . .

RUN mkdir -p /data/queries /data/downloads && \
    chown -R ${UID}:${GID} /app /data /home/node /opt/pw-browsers

USER ${UID}
CMD ["node", "index.js"]
