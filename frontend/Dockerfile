FROM node:18-alpine

WORKDIR /app

COPY frontend/package*.json ./
RUN npm install --silent

COPY frontend/ .
COPY shared/ ./shared/

EXPOSE 5173

CMD ["/bin/sh", "-c", "if [ \"$NODE_ENV\" = \"development\" ]; then npm run dev -- --host 0.0.0.0; else npm run build && npm run start -- --port 5173 --host 0.0.0.0; fi"]
