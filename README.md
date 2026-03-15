# NLR-AUTODOWNLOADER

Crawl and download documents from the National Library of Russia using Playwright.

## Run and test

This project can be run with Docker Compose (recommended) or locally for development.

### 1) Using Docker Compose

- Build and start services:

  docker-compose up --build

- Service will be available at http://localhost:${SERVER_PORT:-3333}
- Quick check: curl http://localhost:3333/health (returns {"status":"ok"})

### 2) Local development (without Docker)

- Install dependencies and Playwright browsers:

  cd server
  npm install
  npx playwright install-deps
  npm run install-browsers

- Start Redis (example using Docker):

  docker run -d --name redis -p 6379:6379 -e REDIS_PASSWORD=1234 redis:8.6.1-alpine --requirepass 1234

- Copy environment example and edit as needed:

  cp ../.env.example ../.env

- Start server in dev mode:

  npm run dev

- Verify health endpoint:

  curl http://localhost:3333/health

### 3) Smoke test

A lightweight smoke test is provided to help automated tooling and AIs verify the app is up and can reach Redis.

From the `server` directory run:

npm run smoke

This checks the /health endpoint and attempts a PING to Redis. Exit code 0 indicates success.

### Notes

- `.env.example` exists at the repo root and contains the environment variables used by the server.
- To run Playwright-driven downloads, a full Firefox installation is required (see `npm run install-browsers`).
- No CI is added; use the smoke script in CI or other automation as desired.

## Setup

1. Copy `.env.example` to `.env` and adjust as needed
2. Run with Docker Compose:

```bash
docker compose up -d
```

The server listens on the port defined by `SERVER_PORT` (default: `3333`).

## Environment Variables

| Variable                     | Default            | Description                                 |
| ---------------------------- | ------------------ | ------------------------------------------- |
| `NODE_ENV`                   | `production`       | `development` enables nodemon hot-reload    |
| `SERVER_PORT`                | `3333`             | HTTP server port                            |
| `DOWNLOADS_DIR`              | `./data/downloads` | Where PDFs are saved                        |
| `CONCURRENT_DOWNLOADS`       | `2`                | Parallel Playwright download workers        |
| `RUN_QUEUE_WATCHER`          | `true`             | Generate `progress.md` report periodically  |
| `DOWNLOADS_WATCHER_INTERVAL` | `60000`            | Report generation interval (ms)             |
| `DOWNLOADS_REPORT_NAME`      | `progress.md`      | Progress report filename in `DOWNLOADS_DIR` |
| `REDIS_HOST`                 | `redis`            | Redis hostname                              |
| `REDIS_PORT`                 | `6379`             | Redis port                                  |
| `REDIS_PASSWORD`             | —                  | Redis password                              |
| `REDIS_DB`                   | `0`                | Redis database index                        |

## API

### Health check

```
GET /health
```

### List all queries

```
GET /playwright/queue
```

### Add queries

```
POST /playwright/queue
Content-Type: application/json

{ "queries": [{ "q": "поиск", "year": 2020 }] }
```

### Get single query status

```
GET /playwright/queue/:queryName
```

`queryName` is the internal identifier returned by the list endpoint (e.g. `поиск_2020`).

### Remove a query

```
DELETE /playwright/queue/:queryName
DELETE /playwright/queue/:queryName?removeDownloads=true   # also deletes downloaded PDFs
```

### Retry a failed query

```
POST /playwright/queue/:queryName/retry
```

Retryable statuses: `download_blocked`, `search_failed`, `pending`.

- `download_blocked` → re-queues the search stage (keeps already-downloaded files).
- `search_failed` / `pending` → restarts from metadata scraping.

## Pipeline

```
POST /playwright/queue
        │
        ▼
  metadataQueue  ── scrapes result count & pagination
        │
        ▼
  searchQueue    ── scrapes all result page URLs
        │
        ▼
  downloadQueue  ── downloads each PDF via Playwright
```

Jobs are backed by Redis (BullMQ) and survive server restarts.
