import { describe, expect, it, vi } from "vitest";
import { checkReadiness } from "../../services/health.service.js";

describe("readiness checks", () => {
  it("reports SQLite, Redis, and downloads as healthy", async () => {
    const database = { $queryRawUnsafe: vi.fn().mockResolvedValue([{ 1: 1 }]) };
    const redis = { ping: vi.fn().mockResolvedValue("PONG") };
    const filesystem = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      unlink: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      checkReadiness({ database, redis, downloadsDir: "/downloads", filesystem })
    ).resolves.toEqual({
      ready: true,
      checks: {
        sqlite: { status: "ok" },
        redis: { status: "ok" },
        downloads: { status: "ok" },
      },
    });
    expect(filesystem.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/^\/downloads\/\.health-/),
      "",
      { flag: "wx" }
    );
    expect(filesystem.unlink).toHaveBeenCalledOnce();
  });

  it("reports an unhealthy dependency without hiding the other results", async () => {
    const database = {
      $queryRawUnsafe: vi.fn().mockRejectedValue(new Error("database is locked")),
    };
    const redis = { ping: vi.fn().mockRejectedValue(new Error("connection refused")) };
    const filesystem = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      unlink: vi.fn().mockResolvedValue(undefined),
    };

    const result = await checkReadiness({
      database,
      redis,
      downloadsDir: "/downloads",
      filesystem,
    });

    expect(result.ready).toBe(false);
    expect(result.checks).toMatchObject({
      sqlite: { status: "error", message: "SQLite unavailable: database is locked" },
      redis: { status: "error", message: "Redis unavailable: connection refused" },
      downloads: { status: "ok" },
    });
  });

  it("reports an unwritable downloads directory", async () => {
    const filesystem = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockRejectedValue(new Error("read-only filesystem")),
      unlink: vi.fn().mockResolvedValue(undefined),
    };

    const result = await checkReadiness({
      database: { $queryRawUnsafe: vi.fn().mockResolvedValue([]) },
      redis: { ping: vi.fn().mockResolvedValue("PONG") },
      downloadsDir: "/downloads",
      filesystem,
    });

    expect(result.ready).toBe(false);
    expect(result.checks.downloads).toEqual({
      status: "error",
      message: "Downloads directory unavailable: read-only filesystem",
    });
    expect(filesystem.unlink).toHaveBeenCalledOnce();
  });
});
