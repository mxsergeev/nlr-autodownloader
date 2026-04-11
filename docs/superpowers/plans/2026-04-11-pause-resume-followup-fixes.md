# Pause/Resume Followup Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three bugs: stale Prisma client crashing pause actions, slow non-optimistic pause/resume UI, and items not appearing in the queue without a manual reload.

**Architecture:** Three independent, minimal changes — one to `docker-compose.yml` (server startup), one to `useQueueMutations.js` (optimistic cache updates), one to `App.jsx` (dynamic refetch interval).

**Tech Stack:** React Query v5 (`useMutation` optimistic pattern, `refetchInterval` function form), Prisma 6 (`prisma generate`), Docker Compose shell command.

**Spec:** `docs/superpowers/specs/2026-04-11-pause-resume-followup-design.md`

---

## File Map

| File | Change |
|---|---|
| `docker-compose.yml` | Prepend `npx prisma generate &&` to server `command` |
| `frontend/src/hooks/useQueueMutations.js` | Replace all 5 mutations with optimistic `onMutate`/`onError`/`onSettled` pattern |
| `frontend/src/App.jsx` | Change `refetchInterval: 3000` to a function that returns `500` when active jobs exist |

---

### Task 1: Regenerate Prisma client on container startup

**Files:**
- Modify: `docker-compose.yml` (server `command` key)

**Why:** The Docker image bakes in a Prisma client generated from the *pre-paused* schema. `prisma migrate deploy` updates the DB but never regenerates the client. Until the client is regenerated, `status: "paused"` throws `PrismaClientValidationError` on every write.

- [ ] **Step 1: Edit `docker-compose.yml`**

Open `docker-compose.yml`. The current server `command` is:

```yaml
    command: /bin/sh -c 'npx prisma migrate deploy && if [ "$NODE_ENV" = "development" ]; then npm run db:studio & STUDIO_PID=$!; npm run dev; kill $STUDIO_PID 2>/dev/null; else npm start; fi'
```

Replace with:

```yaml
    command: /bin/sh -c 'npx prisma generate && npx prisma migrate deploy && if [ "$NODE_ENV" = "development" ]; then npm run db:studio & STUDIO_PID=$!; npm run dev; kill $STUDIO_PID 2>/dev/null; else npm start; fi'
```

Only `npx prisma generate &&` is added at the start of the shell string.

- [ ] **Step 2: Verify the diff is correct**

```bash
git diff docker-compose.yml
```

Expected: one line changed inside the `command` key, adding `npx prisma generate &&`.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "fix(docker): regenerate Prisma client at container startup

Ensures the Prisma client is always in sync with schema.prisma.
Fixes PrismaClientValidationError when writing status='paused'.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Optimistic updates for all queue mutations

**Files:**
- Modify: `frontend/src/hooks/useQueueMutations.js`

**Why:** Every mutation currently calls `invalidateQueries`, which waits for a full GET roundtrip before the UI reflects the user's action. Optimistic updates flip the local cache immediately; `onError` rolls back; `onSettled` syncs the true server state.

- [ ] **Step 1: Replace the entire file content**

Replace `frontend/src/hooks/useQueueMutations.js` with:

```js
import React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { deleteQuery, retryQuery, pauseQuery, pauseItem, deleteItem } from '../api/queue.api.js'

/**
 * @typedef {{ open: boolean, message: string, severity: 'success' | 'error' }} SnackbarState
 */

/**
 * Provides mutations for delete, retry, pause, and per-item actions, plus shared snackbar state.
 * All mutations update the cache optimistically and sync with the server via onSettled.
 * @returns {{
 *   deleteMutation: import('@tanstack/react-query').UseMutationResult,
 *   retryMutation: import('@tanstack/react-query').UseMutationResult,
 *   pauseMutation: import('@tanstack/react-query').UseMutationResult,
 *   pauseItemMutation: import('@tanstack/react-query').UseMutationResult,
 *   deleteItemMutation: import('@tanstack/react-query').UseMutationResult,
 *   snackbar: SnackbarState,
 *   closeSnackbar: () => void,
 * }}
 */
export function useQueueMutations() {
  const qc = useQueryClient()
  const [snackbar, setSnackbar] = React.useState({ open: false, message: '', severity: 'success' })

  const closeSnackbar = () => setSnackbar((s) => ({ ...s, open: false }))

  const deleteMutation = useMutation({
    mutationFn: (id) => deleteQuery(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['queue'] })
      const prev = qc.getQueryData(['queue'])
      qc.setQueryData(['queue'], (old) => old?.filter((q) => q.id !== id) ?? [])
      return { prev }
    },
    onError: (_err, _id, ctx) => {
      qc.setQueryData(['queue'], ctx?.prev)
      setSnackbar({ open: true, message: 'Failed to remove query', severity: 'error' })
    },
    onSuccess: (_, id) => {
      setSnackbar({ open: true, message: `Removed query ${id}`, severity: 'success' })
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['queue'] }),
  })

  const retryMutation = useMutation({
    mutationFn: (id) => retryQuery(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['queue'] })
      const prev = qc.getQueryData(['queue'])
      qc.setQueryData(['queue'], (old) =>
        old?.map((q) => (q.id === id ? { ...q, status: 'pending' } : q)) ?? []
      )
      return { prev }
    },
    onError: (_err, _id, ctx) => {
      qc.setQueryData(['queue'], ctx?.prev)
      setSnackbar({
        open: true,
        message: _err?.response?.data?.error || _err?.message || 'Failed to retry query',
        severity: 'error',
      })
    },
    onSuccess: (_, id) => {
      setSnackbar({ open: true, message: `Retrying query ${id}`, severity: 'success' })
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['queue'] }),
  })

  const pauseMutation = useMutation({
    mutationFn: (id) => pauseQuery(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['queue'] })
      const prev = qc.getQueryData(['queue'])
      qc.setQueryData(['queue'], (old) =>
        old?.map((q) => {
          if (q.id !== id) return q
          return { ...q, status: q.status === 'paused' ? 'downloading' : 'paused' }
        }) ?? []
      )
      return { prev }
    },
    onError: (_err, _id, ctx) => {
      qc.setQueryData(['queue'], ctx?.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['queue'] }),
  })

  const pauseItemMutation = useMutation({
    mutationFn: ({ queryId, itemId }) => pauseItem(queryId, itemId),
    onMutate: async ({ queryId, itemId }) => {
      await qc.cancelQueries({ queryKey: ['queue'] })
      const prev = qc.getQueryData(['queue'])
      qc.setQueryData(['queue'], (old) =>
        old?.map((q) => {
          if (q.id !== queryId) return q
          return {
            ...q,
            searchResults: q.searchResults?.map((r) =>
              r.id === itemId ? { ...r, status: r.status === 'paused' ? 'pending' : 'paused' } : r
            ),
          }
        }) ?? []
      )
      return { prev }
    },
    onError: (_err, _vars, ctx) => {
      qc.setQueryData(['queue'], ctx?.prev)
      setSnackbar({
        open: true,
        message: _err?.response?.data?.error || _err?.message || 'Failed to pause item',
        severity: 'error',
      })
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['queue'] }),
  })

  const deleteItemMutation = useMutation({
    mutationFn: ({ queryId, itemId }) => deleteItem(queryId, itemId),
    onMutate: async ({ queryId, itemId }) => {
      await qc.cancelQueries({ queryKey: ['queue'] })
      const prev = qc.getQueryData(['queue'])
      qc.setQueryData(['queue'], (old) =>
        old?.map((q) => {
          if (q.id !== queryId) return q
          return {
            ...q,
            searchResults: q.searchResults?.filter((r) => r.id !== itemId),
            results: q.results != null ? q.results - 1 : q.results,
          }
        }) ?? []
      )
      return { prev }
    },
    onError: (_err, _vars, ctx) => {
      qc.setQueryData(['queue'], ctx?.prev)
      setSnackbar({
        open: true,
        message: _err?.response?.data?.error || _err?.message || 'Failed to remove item',
        severity: 'error',
      })
    },
    onSuccess: (_, { itemId }) => {
      setSnackbar({ open: true, message: `Removed item ${itemId}`, severity: 'success' })
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['queue'] }),
  })

  return { deleteMutation, retryMutation, pauseMutation, pauseItemMutation, deleteItemMutation, snackbar, closeSnackbar }
}
```

- [ ] **Step 2: Verify syntax**

```bash
node --check frontend/src/hooks/useQueueMutations.js 2>&1 || echo "JS (not JSX) — check manually"
```

Scan the output for syntax errors. If none, proceed.

- [ ] **Step 3: Spot-check the optimistic logic**

Manually verify (search the file) that:
- Every mutation has `onMutate` that calls `cancelQueries`, snapshots `prev`, calls `setQueryData`, and returns `{ prev }`.
- Every `onError` calls `setQueryData(ctx?.prev)`.
- Every `onSettled` calls `invalidateQueries`.

```bash
grep -c "onMutate\|onError\|onSettled" frontend/src/hooks/useQueueMutations.js
```

Expected: `15` (3 per mutation × 5 mutations).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/hooks/useQueueMutations.js
git commit -m "fix(ui): optimistic updates for all queue mutations

Pause, resume, delete, and retry now update the cache immediately.
onError rolls back; onSettled syncs the true server state.
Eliminates full GET roundtrip before UI reflects user action.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Dynamic refetch interval based on active jobs

**Files:**
- Modify: `frontend/src/App.jsx`

**Why:** The static 3 s interval means newly added items can take up to 3 s to appear after the metadata/search workers finish. React Query supports `refetchInterval` as a function receiving the query object, so we can return 500 ms while any job is active and 3000 ms when idle — without a chicken-and-egg problem.

- [ ] **Step 1: Update `useQuery` in `App.jsx`**

Find this block in `frontend/src/App.jsx` (lines 17–25):

```js
  const {
    data: queue = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['queue'],
    queryFn: fetchQueue,
    refetchInterval: 3000,
  })
```

Replace with:

```js
  const {
    data: queue = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['queue'],
    queryFn: fetchQueue,
    refetchInterval: (query) =>
      query.state.data?.some((q) => ['pending', 'downloading'].includes(q.status)) ? 500 : 3000,
  })
```

No other changes to `App.jsx`.

- [ ] **Step 2: Verify the edit**

```bash
grep -A3 "refetchInterval" frontend/src/App.jsx
```

Expected output contains the function form `(query) =>` and `500 : 3000`.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/App.jsx
git commit -m "fix(ui): dynamic refetch interval — 500ms when jobs active, 3s when idle

Ensures search results appear within ~500ms of metadata/search workers
finishing, without hammering the server when the queue is idle.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Post-implementation verification

After all three tasks are committed, restart the stack and verify:

```bash
docker compose down && docker compose up --build
```

Watch startup logs for `npx prisma generate` completing successfully (look for `Generated Prisma Client`).

Then check:
1. **Pause a whole query** → UI status flips instantly; server confirms or rolls back within ~1 s.
2. **Pause an individual item** → item row reflects paused state immediately.
3. **Add a new URL** → queue entry appears; within ~0.5 s of metadata/search jobs finishing, items populate without any reload.
4. **No `PrismaClientValidationError`** in server logs when pausing.
