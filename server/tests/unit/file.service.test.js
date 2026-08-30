import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DOWNLOADS_DIR,
  createZipStream,
  findDownloadedFile,
  getDownloadedFilePath,
  getDownloadedFileNames,
  getDisplayFileName,
  isValidPdfFile,
  sanitizeFileName,
  verifyDownloads,
} from "../../services/file.service.js";
import { makeSearchResultFixture } from "../fixtures/query.fixture.js";

describe("file service", () => {
  afterEach(async () => {
    await fs.rm(path.join(DOWNLOADS_DIR, "42"), { recursive: true, force: true });
    await fs.rm(path.join(DOWNLOADS_DIR, ".tmp"), { recursive: true, force: true });
  });

  it("sanitizes unsafe characters while preserving a simple extension", () => {
    expect(sanitizeFileName("A/B: C?.pdf")).toBe("A_B_ C_.pdf");
    expect(sanitizeFileName("book.title.pdf")).toBe("booktitle.pdf");
  });

  it("finds valid downloaded files by SearchResult ID", async () => {
    const queryDirectory = path.join(DOWNLOADS_DIR, "42");
    await fs.mkdir(queryDirectory, { recursive: true });
    await fs.writeFile(getDownloadedFilePath(42, 7), "%PDF-1.7 sample");

    await expect(getDownloadedFileNames({ id: 42 })).resolves.toEqual(new Set(["7"]));
    await expect(findDownloadedFile(42, 7)).resolves.toBe(getDownloadedFilePath(42, 7));
    await expect(findDownloadedFile(42, "book")).resolves.toBeNull();
  });

  it("identifies only search results whose file name is absent", () => {
    const downloaded = new Set(["already-there"]);
    const results = [
      makeSearchResultFixture({ fileName: "already-there" }),
      makeSearchResultFixture({ href: "second", fileName: "needs-download" }),
    ];

    expect(verifyDownloads(downloaded, results).missingFiles).toEqual([results[1]]);
  });

  it("uses distinct ID paths for documents with identical display names", async () => {
    const first = makeSearchResultFixture({ id: 101, fileName: "Same Book" });
    const second = makeSearchResultFixture({ id: 102, fileName: "Same Book" });
    const firstPath = getDownloadedFilePath(42, first.id);
    const secondPath = getDownloadedFilePath(42, second.id);

    expect(firstPath).toBe(path.join(DOWNLOADS_DIR, "42", "101.pdf"));
    expect(secondPath).toBe(path.join(DOWNLOADS_DIR, "42", "102.pdf"));
    expect(firstPath).not.toBe(secondPath);

    await fs.mkdir(path.dirname(firstPath), { recursive: true });
    await fs.writeFile(firstPath, "%PDF-1.7 first");
    await fs.writeFile(secondPath, "%PDF-1.7 second");

    const downloaded = await getDownloadedFileNames({ id: 42 });
    expect(verifyDownloads(downloaded, [first, second]).missingFiles).toEqual([]);
  });

  it.each([
    ["empty", ""],
    ["HTML", "<!doctype html>"],
    ["partial", "%PDF"],
  ])("rejects %s files as downloads", async (_label, contents) => {
    const filePath = path.join(DOWNLOADS_DIR, "42", "201.pdf");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);

    await expect(isValidPdfFile(filePath)).resolves.toBe(false);
    await expect(getDownloadedFileNames({ id: 42 })).resolves.toEqual(new Set());
  });

  it("rewrites ZIP entries with valid friendly names and skips invalid records", async () => {
    const records = [
      { id: 301, status: "completed", fileName: "Same Book", title: "Same Book" },
      { id: 302, status: "completed", fileName: "Same Book", title: "Same Book" },
      { id: 303, status: "completed", fileName: "Broken", title: "Broken" },
      { id: 304, status: "pending", fileName: "Pending", title: "Pending" },
    ];
    await fs.mkdir(path.join(DOWNLOADS_DIR, "42"), { recursive: true });
    await fs.writeFile(getDownloadedFilePath(42, 301), "%PDF-1.7 first");
    await fs.writeFile(getDownloadedFilePath(42, 302), "%PDF-1.7 second");
    await fs.writeFile(getDownloadedFilePath(42, 303), "<html>not a PDF</html>");
    await fs.writeFile(getDownloadedFilePath(42, 304), "%PDF-1.7 pending");

    const archive = await createZipStream(42, records);
    expect(archive.entryCount).toBe(2);
    expect(archive.entryNames).toEqual(["Same Book.pdf", "Same Book (2).pdf"]);
    expect(getDisplayFileName(records[0])).toBe("Same Book.pdf");
  });

  it("resolves individual downloads by stable ID, not display name", async () => {
    const item = makeSearchResultFixture({ id: 401, fileName: "Friendly Name" });
    const filePath = getDownloadedFilePath(42, item.id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "%PDF-1.7 sample");

    await expect(findDownloadedFile(42, item.id)).resolves.toBe(filePath);
    await expect(findDownloadedFile(42, item)).resolves.toBe(filePath);
    expect(getDisplayFileName(item)).toBe("Friendly Name.pdf");
  });
});
