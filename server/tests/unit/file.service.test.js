import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DOWNLOADS_DIR,
  findDownloadedFile,
  getDownloadedFileNames,
  sanitizeFileName,
  verifyDownloads,
} from "../../services/file.service.js";
import { makeSearchResultFixture } from "../fixtures/query.fixture.js";

describe("file service", () => {
  afterEach(async () => {
    await fs.rm(path.join(DOWNLOADS_DIR, "42"), { recursive: true, force: true });
  });

  it("sanitizes unsafe characters while preserving a simple extension", () => {
    expect(sanitizeFileName("A/B: C?.pdf")).toBe("A_B_ C_.pdf");
    expect(sanitizeFileName("book.title.pdf")).toBe("booktitle.pdf");
  });

  it("finds downloaded names in a query-specific temporary directory", async () => {
    const queryDirectory = path.join(DOWNLOADS_DIR, "42");
    await fs.mkdir(queryDirectory, { recursive: true });
    await fs.writeFile(path.join(queryDirectory, "book.pdf"), "%PDF-1.7 sample");

    await expect(getDownloadedFileNames({ id: 42 })).resolves.toEqual(new Set(["book"]));
    await expect(findDownloadedFile(42, "book")).resolves.toBe(
      path.join(queryDirectory, "book.pdf")
    );
  });

  it("identifies only search results whose file name is absent", () => {
    const downloaded = new Set(["already-there"]);
    const results = [
      makeSearchResultFixture({ fileName: "already-there" }),
      makeSearchResultFixture({ href: "second", fileName: "needs-download" }),
    ];

    expect(verifyDownloads(downloaded, results).missingFiles).toEqual([results[1]]);
  });
});
