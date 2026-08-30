# NLR Autodownloader

Crawl and download documents from National Library of Russia (Primo) result pages using Playwright, BullMQ, Redis, and SQLite.

## What this project does

- Accepts one or more Primo result-page URLs.
- Scrapes query metadata (result count, pages).
- Scrapes all document links for each query.
- Downloads document PDFs in parallel.
- Stores queue state and document records in SQLite.
- Provides a React UI to add, retry, inspect, and remove queued queries.

## Stack and services

- `server/`: Express API + BullMQ workers + Playwright scraper/downloader + Prisma.
- `frontend/`: React 19 + MUI + TanStack Query queue manager UI.
- `redis`: BullMQ backend.
- `sqlite` (via Prisma): persistent data for queries and search results, stored in a Docker volume.

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

Data is persisted in Docker volumes (`redis_data`, `queries_data`) and downloaded files are mounted from `${DOWNLOADS_HOST_DIR}` (default `./data/downloads`) to `/data/downloads` inside the server container.

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
  docker compose exec server npm run db:migrate
  docker compose exec server npm run db:migrate:dev
  ```

### Database migrations

Use `npm run db:migrate` for deployments and startup migration checks. On a
fresh SQLite database it runs the tracked baseline and query-lifecycle
migrations with `prisma migrate deploy`. On a database created by an older
release with `prisma db push`, it verifies the expected `Query` and
`SearchResult` schema, records the existing schema as the tracked baseline,
and applies the lifecycle-column migration without recreating application
rows. A database that already has both lifecycle columns is adopted as having
both migrations applied.

The wrapper refuses incomplete or incompatible legacy schemas instead of
guessing or rewriting them. Back up an existing database before upgrading;
resolve such a schema deliberately before retrying. `npm run db:migrate:deploy`
is available for databases that already have normal Prisma migration history.
The Compose startup command should run `npm run db:migrate` before the server
workers start; `db:push` is not a production deployment mechanism.

## Environment variables

### Core

| Variable               | Default                                                       | Description |
| ---------------------- | ------------------------------------------------------------- | ----------- |
| `NODE_ENV`             | `production`                                                  | Use `development` for hot reload and Prisma Studio in compose. |
| `SERVER_PORT`          | `3333`                                                        | Host port mapped to the server container's internal port `3333`. |
| `DOWNLOADS_HOST_DIR`   | `./data/downloads`                                            | Host directory mounted at the container path in `DOWNLOADS_DIR`. |
| `DOWNLOADS_DIR`        | `/data/downloads`                                             | Download path used by Node inside the container. |
| `CONCURRENT_DOWNLOADS` | `2`                                                           | Download worker concurrency. |
| `PLAYWRIGHT_HEADLESS`  | `true` (implicit if unset)                                   | Set to `false` to run browser non-headless. |
| `MAX_QUEUE_BATCH_SIZE` | `100`                                                         | Maximum number of query objects accepted by one queue request. |
| `READINESS_TIMEOUT_MS` | `1000`                                                        | Timeout for each SQLite/Redis readiness check. |
| `DATABASE_URL`         | `file:/data/queries/nlr.db`                                   | Prisma/SQLite database path (inside container). |

### Redis

| Variable         | Default | Description |
| ---------------- | ------- | ----------- |
| `REDIS_HOST`     | `redis` | Redis host used inside the Compose network. |
| `REDIS_PORT`     | `6379`  | Host port mapped to Redis's internal port `6379`; the server override always uses `6379` internally. |
| `REDIS_PASSWORD` | `1234`  | Redis password. |
| `REDIS_DB`       | `0`     | Redis database index. |

| `NEXTCLOUD_GID`     | `33`                   | Optional group id added to the server container. |

## API

Base path: `/api`

### `GET /health`

Returns:

```json
{ "status": "ok" }
```

`GET /health/live` is a dependency-free liveness check. `GET /health/ready`
returns `200` only when SQLite, Redis, and the configured downloads directory
are available and writable; otherwise it returns `503` with per-dependency
statuses.

### `GET /api/queue`

Returns all queued queries (ordered) with nested `searchResults`.

### `POST /api/queue`

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

### `DELETE /api/queue/:id`

Removes a query by numeric id, removes related queued jobs, and deletes downloaded files for that query directory.

### `POST /api/queue/:id/retry`

Retries a query when status is retryable (`download_blocked`, `search_failed`).

- If status is `download_blocked`, only missing downloads are queued.
- Otherwise, metadata scraping is queued again from the start.

### `POST /api/queue/:id/pause`

Toggles pause on a query. Removes waiting download jobs for pending items and marks them `paused`. Resuming re-queues those jobs.

### `POST /api/queue/:id/items/:itemId/pause`

Toggles pause on a single search result item.

### `DELETE /api/queue/:id/items/:itemId`

Removes a single search result item, cancels its queued job.

## Query status lifecycle

```
pending
  → fetching_metadata   (metadata worker started)
  → fetching_results    (metadata scraped; search worker enqueued)
  → downloading         (all download jobs enqueued)
  → completed           (all files downloaded)
```

Failure states:

- `search_failed` — metadata or search scraping failed after all retries
- `download_blocked` — PDF download inaccessible after all retries

Paused state:

- `paused` — user paused the query; pending download jobs removed, items marked `paused`

Each `SearchResult` row also stores an item-level status: `pending`, `completed`, `download_blocked`, or `paused`.

Retryable statuses: `search_failed`, `download_blocked`.

## Pipeline

```text
POST /api/queue
        |
        v
metadataQueue  -- scrape result count/parts and canonical page URL
        |        (Query status: fetching_metadata → fetching_results)
        v
searchQueue    -- scrape and persist all search result items
        |        (Query status: fetching_results → downloading)
        v
downloadQueue  -- download missing PDFs into DOWNLOADS_DIR/<queryId>/
                  (Query status: downloading → completed)
```

Jobs are persisted in Redis and metadata/search results are persisted in SQLite via Prisma.
Failed download jobs are retried (up to 10 times) with a 2-second fixed backoff between attempts.

## Frontend behavior

The frontend (`frontend/`) polls `/api/queue` every 3 seconds and supports:

- Adding URLs to queue.
- Expanding query rows to inspect result items and statuses.
- Retrying retryable queries.
- Pausing/resuming queries and individual items.
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
