# NLR-AUTODOWNLOADER

Crawl and download documents from the National Library of Russia using Playwright.

## Setup

1. Copy `.env.example` to `.env` and adjust as needed
2. Run with Docker Compose:

```bash
docker compose up -d
```

The server listens on the port defined by `SERVER_PORT` (default: `3333`).

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `production` | `development` enables nodemon hot-reload |
| `SERVER_PORT` | `3333` | HTTP server port |
| `DOWNLOADS_DIR` | `./data/downloads` | Where PDFs are saved |
| `CONCURRENT_DOWNLOADS` | `2` | Parallel Playwright download workers |
| `RUN_QUEUE_WATCHER` | `true` | Generate `progress.md` report periodically |
| `DOWNLOADS_WATCHER_INTERVAL` | `60000` | Report generation interval (ms) |
| `DOWNLOADS_REPORT_NAME` | `progress.md` | Progress report filename in `DOWNLOADS_DIR` |
| `REDIS_HOST` | `redis` | Redis hostname |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | — | Redis password |
| `REDIS_DB` | `0` | Redis database index |

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
