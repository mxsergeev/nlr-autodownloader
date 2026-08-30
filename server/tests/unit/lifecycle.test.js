import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  collectResources,
  createShutdownHandler,
  installShutdownHandlers,
} from "../../lifecycle.js";

describe("application lifecycle", () => {
  it("closes resources in dependency-safe order and is idempotent", async () => {
    const events = [];
    const server = {
      close(callback) {
        events.push("http");
        callback();
      },
    };
    const worker = { close: vi.fn(async () => events.push("worker")) };
    const queue = { close: vi.fn(async () => events.push("queue")) };
    const browser = vi.fn(async () => events.push("browser"));
    const redis = { quit: vi.fn(async () => events.push("redis")) };
    const database = { $disconnect: vi.fn(async () => events.push("sqlite")) };
    const shutdown = createShutdownHandler({
      server,
      workers: [worker],
      queues: [queue],
      browser,
      redis,
      database,
      logger: { error: vi.fn() },
    });

    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);

    expect(events).toEqual(["http", "worker", "queue", "browser", "redis", "sqlite"]);
    expect(worker.close).toHaveBeenCalledOnce();
    expect(queue.close).toHaveBeenCalledOnce();
    expect(redis.quit).toHaveBeenCalledOnce();
    expect(database.$disconnect).toHaveBeenCalledOnce();
  });

  it("continues cleanup after a resource close fails", async () => {
    const events = [];
    const logger = { error: vi.fn() };
    const shutdown = createShutdownHandler({
      server: { close: (callback) => callback() },
      workers: [{ close: vi.fn().mockRejectedValue(new Error("worker failure")) }],
      queues: [{ close: vi.fn(async () => events.push("queue")) }],
      browser: vi.fn(async () => events.push("browser")),
      redis: { quit: vi.fn(async () => events.push("redis")) },
      database: { $disconnect: vi.fn(async () => events.push("sqlite")) },
      logger,
    });

    await shutdown();

    expect(events).toEqual(["queue", "browser", "redis", "sqlite"]);
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it("collects closeable workers from dynamic-import module namespaces", () => {
    const close = vi.fn();
    const worker = { close };
    expect(collectResources([{ metadataWorker: worker }, { metadataWorker: worker }])).toEqual([
      worker,
    ]);
  });

  it("installs and unregisters one handler for each termination signal", async () => {
    const processObject = new EventEmitter();
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const unregister = installShutdownHandlers(shutdown, {
      process: processObject,
      logger: console,
    });

    processObject.emit("SIGTERM");
    processObject.emit("SIGINT");
    await Promise.resolve();
    expect(shutdown).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(shutdown).toHaveBeenNthCalledWith(2, "SIGINT");

    unregister();
    expect(processObject.listenerCount("SIGTERM")).toBe(0);
    expect(processObject.listenerCount("SIGINT")).toBe(0);
  });
});
