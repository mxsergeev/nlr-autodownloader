# NLR Autodownloader

Crawl and download documents from National Library of Russia (Primo) result pages using Playwright, BullMQ, Redis, and PostgreSQL.

## What this project does

- Accepts one or more Primo result-page URLs.
- Scrapes query metadata (result count, pages).
- Scrapes all document links for each query.
- Downloads document PDFs in parallel.
- Stores queue state and document records in PostgreSQL.
- Provides a React UI to add, retry, inspect, and remove queued queries.

## Stack and services

- `server/`: Express API + BullMQ workers + Playwright scraper/downloader + Prisma.
- `frontend/`: React 19 + MUI + TanStack Query queue manager UI.
- `redis`: BullMQ backend.
- `postgres`: persistent data for queries and search results.

Main queues:

- `metadataQueue`: scrape result count and pagination metadata.
- `searchQueue`: scrape all result links.
- `downloadQueue`: download missing PDFs.

## Quick start (Docker Compose)

1. Copy environment file:

   ```bash
   cp .env.example .env
   ```

2. For local development, set `NODE_ENV=development` in `.env` (enables hot reload and Prisma Studio in the server container).

3. Build and start all services:

   ```bash
   docker compose up --build
   ```

4. Open:

- Frontend UI: `http://localhost:5173`
- Server API: `http://localhost:${SERVER_PORT:-3333}`
- Health check: `http://localhost:${SERVER_PORT:-3333}/health`
- Prisma Studio (development mode): `http://localhost:5555`

Data is persisted in Docker volumes (`postgres_data`, `redis_data`, `queries_data`) and downloaded files are mounted to `${DOWNLOADS_DIR}` (default `./data/downloads`).

## Development workflow

- Server and frontend sources are bind-mounted, so code changes reload automatically in development mode.
- Rebuild only server when dependencies or server Dockerfile context changes:

  ```bash
  docker compose up --build --force-recreate --no-deps server
  ```

- Useful server commands:

  ```bash
  docker compose exec server npm run smoke
  docker compose exec server npm run lint
  docker compose exec server npm run db:migrate:dev
  ```

## Environment variables

### Core

| Variable               | Default                                                       | Description |
| ---------------------- | ------------------------------------------------------------- | ----------- |
| `NODE_ENV`             | `production`                                                  | Use `development` for hot reload and Prisma Studio in compose. |
| `SERVER_PORT`          | `3333`                                                        | Express server port. |
| `DOWNLOADS_DIR`        | `./data/downloads`                                            | Host directory mounted for downloaded files. |
| `CONCURRENT_DOWNLOADS` | `2`                                                           | Download worker concurrency. |
| `PLAYWRIGHT_HEADLESS`  | `true` (implicit if unset)                                   | Set to `false` to run browser non-headless. |
| `DATABASE_URL`         | `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}` | Prisma/PostgreSQL connection string. |

### Redis

| Variable         | Default | Description |
| ---------------- | ------- | ----------- |
| `REDIS_HOST`     | `redis` | Redis host for BullMQ/ioredis. |
| `REDIS_PORT`     | `6379`  | Redis port. |
| `REDIS_PASSWORD` | `1234`  | Redis password. |
| `REDIS_DB`       | `0`     | Redis database index. |

### PostgreSQL

| Variable            | Default                | Description |
| ------------------- | ---------------------- | ----------- |
| `POSTGRES_USER`     | `nlr`                  | PostgreSQL username. |
| `POSTGRES_PASSWORD` | `nlr_secret`           | PostgreSQL password. |
| `POSTGRES_DB`       | `nlr_autodownloader`   | PostgreSQL database name. |
| `NEXTCLOUD_GID`     | `33`                   | Optional group id added to the server container. |

## API

Base path: `/playwright`

### `GET /health`

Returns:

```json
{ "status": "ok" }
```

### `GET /playwright/queue`

Returns all queued queries (ordered) with nested `searchResults`.

### `POST /playwright/queue`

Add one or more query URLs:

```json
{
  "queries": [
    { "url": "https://primo.nlr.ru/primo-explore/search?query=any,contains,..." }
  ]
}
```

Each item must include `url`. Response includes updated queue and per-item failures:

```json
{ "failed": [], "queue": [...] }
```

### `DELETE /playwright/queue/:id`

Removes a query by numeric id, removes related queued jobs, and deletes downloaded files for that query directory.

### `POST /playwright/queue/:id/retry`

Retries a query when status is retryable (`download_blocked`, `search_failed`, `pending`, `failed`).

- If status is `download_blocked`, only missing downloads are queued.
- Otherwise, metadata scraping is queued again.

## Query status lifecycle

`pending` -> `downloading` -> `completed`

Failure-oriented states:

- `download_blocked`
- `search_failed`

Each search result row also stores an item-level status.

## Pipeline

```text
POST /playwright/queue
        |
        v
metadataQueue  -- scrape result count/parts and canonical page URL
        |
        v
searchQueue    -- scrape and persist all search result items
        |
        v
downloadQueue  -- download missing PDFs into DOWNLOADS_DIR/<queryId>/
```

Jobs are persisted in Redis and metadata/search results are persisted in PostgreSQL.

## Frontend behavior

The frontend (`frontend/`) polls `/playwright/queue` every 3 seconds and supports:

- Adding URLs to queue.
- Expanding query rows to inspect result items and statuses.
- Retrying retryable queries.
- Deleting queries with confirmation.

In compose, frontend API proxy target is set by `VITE_SERVER_HOST`/`VITE_SERVER_PORT`.

## Smoke test

Run from the server container:

```bash
docker compose exec server npm run smoke
```

The smoke script checks:

- `GET /health`
- Redis `PING`
