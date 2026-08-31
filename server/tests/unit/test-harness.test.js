import { describe, expect, it } from "vitest";
import { barrier, deferred } from "../helpers/deferred.js";

describe("deterministic test harness", () => {
  it("supports releasing a suspended operation without a timer", async () => {
    const started = deferred();
    const continueOperation = deferred();
    const operation = (async () => {
      started.resolve();
      await continueOperation.promise;
      return "released";
    })();

    await started.promise;
    continueOperation.resolve();
    await expect(operation).resolves.toBe("released");
  });

  it("provides explicit started and continuation barriers", async () => {
    const operationBarrier = barrier();
    const operation = operationBarrier.wait();

    await operationBarrier.started.promise;
    operationBarrier.continue.resolve("released");

    await expect(operation).resolves.toBe("released");
  });
});
