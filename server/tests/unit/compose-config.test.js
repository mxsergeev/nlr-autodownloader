import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const compose = await readFile(
  fileURLToPath(new URL("../../../docker-compose.yml", import.meta.url)),
  "utf8"
);
const environment = await readFile(
  fileURLToPath(new URL("../../../.env.example", import.meta.url)),
  "utf8"
);

describe("Compose deployment configuration", () => {
  it("maps custom host ports to fixed service ports", () => {
    expect(compose).toContain('"${SERVER_PORT:-3333}:3333"');
    expect(compose).toContain('SERVER_PORT: "3333"');
    expect(compose).toContain('"${REDIS_PORT:-6379}:6379"');
    expect(compose).toContain("REDIS_HOST: redis");
    expect(compose).toContain('REDIS_PORT: "6379"');
  });

  it("keeps the host downloads directory separate from the container path", () => {
    expect(compose).toContain("${DOWNLOADS_HOST_DIR:-./data/downloads}:/data/downloads:shared");
    expect(compose).toContain("DOWNLOADS_DIR: /data/downloads");
    expect(environment).toContain("DOWNLOADS_HOST_DIR=./data/downloads");
    expect(environment).toContain("DOWNLOADS_DIR=/data/downloads");
  });

  it("runs the tracked migration wrapper during server startup", () => {
    expect(compose).toContain("npm run db:migrate");
    expect(compose).not.toContain("prisma db push");
  });
});
