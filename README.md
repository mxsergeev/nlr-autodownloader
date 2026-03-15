# NLR-AUTODOWNLOADER

Crawl and download documents from the National Library of Russia using Playwright.

## Run and test

This project is developed and run with Docker Compose (recommended).

### Development with Docker Compose

1. Copy environment example and adjust as needed:

   cp .env.example .env

   Edit `.env` to set `NODE_ENV=development` for hot-reload during development.

2. Build and start services (server + redis):

   docker-compose up --build

   This builds the server image (the Dockerfile installs Playwright dependencies and Firefox) and starts Redis.

3. Access the server at http://localhost:${SERVER_PORT:-3333}

4. Iterative development (hot reload):
   - Ensure `NODE_ENV=development` in `.env` so the container runs `npm run dev` (nodemon).
   - Code changes on the host are mounted into the container (see docker-compose.yml), so changes reload automatically.
   - To rebuild the server image after changing dependencies or package.json:

     docker-compose up --build --force-recreate --no-deps server

5. Running helper commands inside the running container:
   - Install browsers (only needed when changing Playwright install target):

     docker-compose exec server npm run install-browsers

   - Run the smoke test:

     docker-compose exec server npm run smoke

   - Run lint:

     docker-compose exec server npm run lint

6. Quick health check from host:

   curl http://localhost:3333/health # returns {"status":"ok"}

### Smoke test

A lightweight smoke test verifies the HTTP health endpoint and Redis connectivity. Run it inside the server container:

docker-compose exec server npm run smoke

Exit code 0 indicates success.

### Notes

- `.env.example` exists at the repo root and contains the environment variables used by the server.
- Data and downloads are mounted to `./data/downloads` by default (see docker-compose.yml).
- The Dockerfile already installs Playwright and Firefox at image build time; running `npm run install-browsers` inside the container can be used to re-install if needed.

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

{ "queries": [{ "q": "search", "year": 2020 }] }
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
