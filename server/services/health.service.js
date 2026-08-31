import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "./db.service.js";
import { connection } from "../queue.js";
import { config } from "../config.js";

/**
 * Checks the dependencies required for the server to accept work. Each
 * dependency is checked independently so operators can see what prevented
 * readiness instead of receiving a generic 503.
 *
 * @param {{
 *   database?: object,
 *   redis?: object,
 *   downloadsDir?: string,
 *   filesystem?: typeof fs,
 * }} [options]
 * @returns {Promise<{ ready: boolean, checks: Record<string, { status: string, message?: string }> }>}
 */
export async function checkReadiness({
  database = prisma,
  redis = connection,
  downloadsDir = config.downloadsDir,
  filesystem = fs,
} = {}) {
  const checks = {
    sqlite: await checkDependency("SQLite", () =>
      withTimeout(pingDatabase(database), config.readinessTimeoutMs, "SQLite check timed out")
    ),
    redis: await checkDependency("Redis", () =>
      withTimeout(pingRedis(redis), config.readinessTimeoutMs, "Redis check timed out")
    ),
    downloads: await checkDependency("Downloads directory", () =>
      checkWritableDirectory(downloadsDir, filesystem)
    ),
  };

  return {
    ready: Object.values(checks).every((check) => check.status === "ok"),
    checks,
  };
}

async function pingDatabase(database) {
  if (!database || typeof database.$queryRawUnsafe !== "function") {
    throw new Error("SQLite client is unavailable");
  }

  await database.$queryRawUnsafe("SELECT 1");
}

async function pingRedis(redis) {
  if (!redis || typeof redis.ping !== "function") {
    throw new Error("Redis client is unavailable");
  }

  await redis.ping();
}

async function withTimeout(operation, timeoutMs, message) {
  const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1000;
  let timer;

  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), duration);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function checkWritableDirectory(directory, filesystem) {
  if (!directory || typeof filesystem?.mkdir !== "function") {
    throw new Error("Downloads directory is not configured");
  }

  await filesystem.mkdir(directory, { recursive: true });

  const probePath = path.join(directory, `.health-${process.pid}-${randomUUID()}`);
  try {
    await filesystem.writeFile(probePath, "", { flag: "wx" });
  } finally {
    if (typeof filesystem.unlink === "function") {
      await filesystem.unlink(probePath).catch(() => null);
    }
  }
}

async function checkDependency(name, operation) {
  try {
    await operation();
    return { status: "ok" };
  } catch (error) {
    return {
      status: "error",
      message: `${name} unavailable: ${error?.message ?? String(error)}`,
    };
  }
}
