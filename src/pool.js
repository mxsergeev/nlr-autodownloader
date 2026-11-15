const MAX_ATTEMPTS = 3
const MAX_CONSECUTIVE_FAILURES = 8
const BASE_COOLDOWN_MS = 15_000
const MAX_COOLDOWN_MS = 5 * 60_000
const START_JITTER_MS = 2000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run task(item) for every item with `workers` running in parallel.
 *
 * The site gives no reliable signal for rate limiting, so every failure is treated as a possible block:
 * all workers pause for a shared cooldown that doubles with each failure in a row, the item goes to the back
 * of the line (up to MAX_ATTEMPTS), and after MAX_CONSECUTIVE_FAILURES in a row the run stops.
 *
 * @returns {Promise<{ failed: { item: any, error: Error }[], aborted: boolean }>}
 */
export async function runPool(items, workers, task, { onError = () => {} } = {}) {
  const queue = items.map((item) => ({ item, attempts: 0 }))
  const failed = []
  let consecutiveFailures = 0
  let cooldownUntil = 0
  let aborted = false

  async function worker() {
    while (!aborted && queue.length > 0) {
      const entry = queue.shift()

      await sleep(Math.max(0, cooldownUntil - Date.now()) + Math.random() * START_JITTER_MS)
      if (aborted) break

      try {
        await task(entry.item)
        consecutiveFailures = 0
      } catch (error) {
        entry.attempts++
        consecutiveFailures++

        const cooldown = Math.min(BASE_COOLDOWN_MS * 2 ** (consecutiveFailures - 1), MAX_COOLDOWN_MS)
        cooldownUntil = Math.max(cooldownUntil, Date.now() + cooldown)

        const retrying = entry.attempts < MAX_ATTEMPTS
        if (retrying) queue.push(entry)
        else failed.push({ item: entry.item, error })

        onError(entry.item, error, { attempt: entry.attempts, retrying, cooldown })

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) aborted = true
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, worker))

  return { failed, aborted }
}
