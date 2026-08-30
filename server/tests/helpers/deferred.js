/**
 * A deterministic promise barrier for processor and lifecycle race tests.
 * Tests can await `started.promise` before changing state, then release the
 * suspended operation with `continue.promise.resolve(value)`.
 */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

export function barrier() {
  const started = deferred();
  const continueOperation = deferred();

  return {
    started,
    continue: continueOperation,
    async wait() {
      started.resolve();
      return continueOperation.promise;
    },
  };
}
