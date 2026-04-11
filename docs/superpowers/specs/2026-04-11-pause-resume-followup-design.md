# Pause/Resume Followup Fixes — Design

**Date:** 2026-04-11
**Status:** Approved

## Problem

Three bugs remain after the initial pause/resume implementation:

1. **Prisma client stale** — `status: "paused"` throws `PrismaClientValidationError` because the
   client was generated at image-build time before `paused` was added to `QueryStatus`. `prisma
   migrate deploy` updates the DB but does not regenerate the client.

2. **Slow pause/resume UI** — every mutation calls `invalidateQueries`, which waits for a full GET
   roundtrip before the UI reflects the action.

3. **Items not appearing after adding a URL** — the `refetchInterval: 3000` is too slow relative to
   how quickly metadata/search jobs complete, and does not help users who are actively watching.

## Architecture

### Fix 1 — Prisma client regeneration at startup

`docker-compose.yml` server startup command gains `npx prisma generate` as the first step:

```
npx prisma generate && npx prisma migrate deploy && node server.js
```

`./server/:/app` is volume-mounted so `schema.prisma` is always the latest from the host.
`/app/node_modules` is an isolated anonymous volume, so the newly generated client persists across
container restarts. This adds ~10 s to startup time but guarantees schema/client parity after every
`docker compose up`.

**No schema or migration changes are needed.** The existing migration already adds `paused` to the
DB; the problem is purely the stale client binary.

### Fix 2 — Optimistic updates

`frontend/src/hooks/useQueueMutations.js` — all five mutations adopt the same pattern:

```
onMutate  → cancelQueries → snapshot prev → setQueryData (optimistic) → return { prev }
onError   → setQueryData(prev)   [roll back]
onSettled → invalidateQueries    [background sync]
```

Predicted state per mutation:

| Mutation | Optimistic change |
|---|---|
| `pauseMutation(id)` | Toggle query `status`: `paused` ↔ `downloading` |
| `pauseItemMutation({ queryId, itemId })` | Toggle item `status`: `paused` ↔ `pending` |
| `deleteMutation(id)` | Remove query from cache array |
| `deleteItemMutation({ queryId, itemId })` | Remove item from `searchResults` |
| `retryMutation(id)` | Set query `status` → `'pending'` |

For `pauseMutation` the predicted toggle uses the current cache value, not hardcoded state, so it
handles intermediate statuses gracefully (e.g. `completed` remains `completed` — the server will
return the real state on `onSettled`).

### Fix 3 — Dynamic refetch interval

`frontend/src/App.jsx`:

```js
const hasActiveJobs = queue.some(q => ['pending', 'downloading'].includes(q.status))

useQuery({
  queryKey: ['queue'],
  queryFn: fetchQueue,
  refetchInterval: hasActiveJobs ? 500 : 3000,
})
```

While any job is `pending` or `downloading` the UI polls every 500 ms; otherwise it falls back to
3 s. This makes newly added items show their search results within half a second of the metadata/
search workers finishing, without hammering the server when the queue is idle.

## Error handling

- **Prisma generate failure at startup**: if `prisma generate` fails the container exits immediately
  (shell `&&` short-circuits), which causes Docker to restart it — the same behaviour as today when
  `migrate deploy` fails.
- **Optimistic rollback**: any mutation error reverts via `onError`. `onSettled` always syncs the
  true server state afterwards.
- **Refetch errors**: existing React Query retry logic handles transient network errors; the dynamic
  interval keeps firing regardless.

## Files changed

| File | Change |
|---|---|
| `docker-compose.yml` | Add `npx prisma generate &&` to server command |
| `frontend/src/hooks/useQueueMutations.js` | Add `onMutate`/`onError`/`onSettled` to all 5 mutations |
| `frontend/src/App.jsx` | Dynamic `refetchInterval` |
