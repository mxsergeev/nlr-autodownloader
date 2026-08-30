import { describe, expect, it } from "vitest";
import { config } from "../../config.js";
import { runDirectory } from "../setup.js";

describe("runtime configuration", () => {
  it("uses the suite's isolated downloads directory", () => {
    expect(config.downloadsDir).toBe(`${runDirectory}/downloads`);
  });

  it("exposes parsed Redis and worker settings in one runtime object", () => {
    expect(config.redis).toMatchObject({ host: "127.0.0.1", port: 6379, db: 0 });
    expect(config.concurrentDownloads).toBeGreaterThan(0);
  });
});
