import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";

const servers = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

describe("HTTP safety and health boundaries", () => {
  it("keeps the legacy health endpoint and exposes dependency-free liveness", async () => {
    const server = await listen(
      createApp({ readinessCheck: async () => ({ ready: true, checks: {} }) })
    );

    const health = await fetch(`${server.url}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: "ok" });

    const live = await fetch(`${server.url}/health/live`);
    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toEqual({ status: "ok" });
  });

  it("returns 503 and per-dependency statuses when readiness fails", async () => {
    const server = await listen(
      createApp({
        readinessCheck: async () => ({
          ready: false,
          checks: {
            sqlite: { status: "ok" },
            redis: { status: "error", message: "Redis unavailable: connection refused" },
            downloads: { status: "ok" },
          },
        }),
      })
    );

    const response = await fetch(`${server.url}/health/ready`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "not_ready",
      checks: {
        sqlite: { status: "ok" },
        redis: { status: "error", message: "Redis unavailable: connection refused" },
        downloads: { status: "ok" },
      },
    });
  });

  it("returns structured partial errors for invalid URLs without creating queue work", async () => {
    const server = await listen(
      createApp({ readinessCheck: async () => ({ ready: true, checks: {} }) })
    );

    const response = await fetch(`${server.url}/api/queue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queries: [
          { url: "http://primo.nlr.ru/discovery/search?query=insecure" },
          { url: "https://attacker.example/private" },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      queued: [],
      failed: [
        { url: "http://primo.nlr.ru/discovery/search?query=insecure" },
        { url: "https://attacker.example/private" },
      ],
      queue: [],
    });
  });

  it("rejects an oversized query batch before processing it", async () => {
    const server = await listen(
      createApp({ readinessCheck: async () => ({ ready: true, checks: {} }) })
    );
    const response = await fetch(`${server.url}/api/queue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queries: Array.from({ length: 101 }, (_, index) => ({
          url: `https://primo.nlr.ru/discovery/search?query=${index}`,
        })),
      }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "A maximum of 100 queries can be queued at once",
    });
  });

  it("rejects JSON bodies over the 32kb parser limit", async () => {
    const server = await listen(
      createApp({ readinessCheck: async () => ({ ready: true, checks: {} }) })
    );
    const response = await fetch(`${server.url}/api/queue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queries: [{ url: "https://primo.nlr.ru/", padding: "x".repeat(33_000) }],
      }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Request body is too large" });
  });
});

async function listen(application) {
  const server = application.listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
