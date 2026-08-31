import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { runDirectory } from "../setup.js";

const browser = vi.hoisted(() => ({ runJob: vi.fn() }));

vi.mock("../../services/browser.service.js", () => browser);

const { parseResultCount, scrapeDownload, scrapeMetadata, scrapeSearchResults } =
  await import("../../services/scraper.service.js");

describe("Primo result-count parsing", () => {
  it.each([
    ["123 результата", 123],
    ["1 234 результата", 1234],
    ["1\u00a0234 результата", 1234],
    ["1\u202f234 результата", 1234],
  ])("parses %j as %d", (text, expected) => {
    expect(parseResultCount(text)).toBe(expected);
  });

  it("returns null when the result count is absent or unsafe", () => {
    expect(parseResultCount("результаты не найдены")).toBeNull();
    expect(parseResultCount(null)).toBeNull();
    expect(parseResultCount("999999999999999999999 результата")).toBeNull();
  });
});

describe("scraper navigation validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await Promise.all(
      [
        "popup.pdf",
        "popup-route.pdf",
        "multipart.pdf",
        "unsafe-viewer.pdf",
        "unsafe-part.pdf",
        "unsafe-part-popup.pdf",
        "unsafe-endpoint.pdf",
      ].map((name) => fs.rm(path.join(runDirectory, name), { force: true }))
    );
  });

  it("rejects a navigation that redirects to an untrusted host before scraping", async () => {
    const page = makeMetadataPage("https://127.0.0.1/private");
    browser.runJob.mockImplementation(async (callback) => callback(page));

    await expect(
      scrapeMetadata({ url: "https://primo.nlr.ru/discovery/search?query=redirect" })
    ).rejects.toThrow("allowed NLR host");
    expect(page.waitForSelector).not.toHaveBeenCalled();
  });

  it("accepts a same-host redirect and records the final allowed URL", async () => {
    const page = makeMetadataPage("https://primo.nlr.ru/discovery/search?canonical=1");
    browser.runJob.mockImplementation(async (callback) => callback(page));

    await expect(
      scrapeMetadata({ url: "https://primo.nlr.ru/discovery/search?query=redirect" })
    ).resolves.toMatchObject({
      results: 1,
      resultsPerPart: 1,
      parts: 1,
      pageUrl: "https://primo.nlr.ru/discovery/search?canonical=1",
    });
  });

  it("rejects an untrusted document link extracted from search results", async () => {
    const page = {
      goto: vi.fn(),
      url: () => "https://primo.nlr.ru/discovery/search?offset=0",
      waitForSelector: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn(() => ({
        evaluateAll: vi
          .fn()
          .mockResolvedValue([{ title: "A document", href: "https://attacker.example/document" }]),
      })),
    };
    browser.runJob.mockImplementation(async (callback) => callback(page));

    await expect(
      scrapeSearchResults({
        searchUrl: "https://primo.nlr.ru/discovery/search?query=documents",
        parts: 1,
        resultsPerPart: 1,
      })
    ).rejects.toThrow("allowed NLR host");
  });

  it("resolves a relative document link against the allowed result page", async () => {
    const page = {
      goto: vi.fn(),
      url: () => "https://primo.nlr.ru/discovery/search?offset=0",
      waitForSelector: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn(() => ({
        evaluateAll: vi
          .fn()
          .mockResolvedValue([{ title: "A document", href: "/discovery/fulldisplay?docid=123" }]),
      })),
    };
    browser.runJob.mockImplementation(async (callback) => callback(page));

    await expect(
      scrapeSearchResults({
        searchUrl: "https://primo.nlr.ru/discovery/search?query=documents",
        parts: 1,
        resultsPerPart: 1,
      })
    ).resolves.toEqual([
      {
        title: "A document",
        href: "https://primo.nlr.ru/discovery/fulldisplay?docid=123",
        fileName: "A document",
      },
    ]);
  });

  it("follows the Primo popup to the Vivaldi viewer and details page", async () => {
    const page = makeVivaldiPage();
    const primoPage = makePrimoDownloadPage(page);
    browser.runJob.mockImplementation(async (callback) => callback(primoPage));
    const temporaryFilePath = path.join(runDirectory, "popup.pdf");

    await expect(
      scrapeDownload(
        { href: "https://primo.nlr.ru/discovery/fulldisplay?docid=07NLR_LMS022470404" },
        temporaryFilePath
      )
    ).resolves.toBe(temporaryFilePath);

    expect(primoPage.goto).toHaveBeenCalledWith(
      "https://primo.nlr.ru/discovery/fulldisplay?docid=07NLR_LMS022470404"
    );
    expect(primoPage.getByLabel).toHaveBeenCalledWith("Электронная копия");
    expect(page.url()).toBe("https://vivaldi.nlr.ru/pm000053466/details");
    expect(page.getByRole).toHaveBeenCalledWith("link", { name: "Карточка" });
    expect(await fs.readFile(temporaryFilePath, "utf8")).toContain("%PDF-");
  });

  it("downloads and merges every prepared Vivaldi part in order", async () => {
    const partDownloads = await Promise.all([makePdfBytes("part one"), makePdfBytes("part two")]);
    const popup = makeVivaldiPage({ partCount: 2, partDownloads });
    const primoPage = makePrimoDownloadPage(popup);
    browser.runJob.mockImplementation(async (callback) => callback(primoPage));
    const temporaryFilePath = path.join(runDirectory, "multipart.pdf");

    await expect(
      scrapeDownload(
        { href: "https://primo.nlr.ru/discovery/fulldisplay?docid=07NLR_LMS022470404" },
        temporaryFilePath
      )
    ).resolves.toBe(temporaryFilePath);

    const merged = await PDFDocument.load(await fs.readFile(temporaryFilePath));
    expect(merged.getPageCount()).toBe(2);
    expect(popup.partClicks).toEqual([0, 1]);
  });

  it("accepts a prepared part popup only at the exact Vivaldi part route", async () => {
    const partPopup = makePartDownloadPopup();
    const popup = makeVivaldiPage({ downloadMode: "popup", partPopup });
    const page = makePrimoDownloadPage(popup);
    browser.runJob.mockImplementation(async (callback) => callback(page));
    const temporaryFilePath = path.join(runDirectory, "popup-route.pdf");

    await expect(
      scrapeDownload(
        { href: "https://primo.nlr.ru/discovery/fulldisplay?docid=07NLR_LMS022470404" },
        temporaryFilePath
      )
    ).resolves.toBe(temporaryFilePath);

    expect(partPopup.url()).toBe("https://vivaldi.nlr.ru/pm000053466/partfile?part=0");
    expect(await fs.readFile(temporaryFilePath, "utf8")).toContain("%PDF-");
  });

  it("rejects a popup that is not the exact Vivaldi viewer route", async () => {
    const popup = makeVivaldiPage({ initialUrl: "https://vivaldi.nlr.ru/pm000053466/details" });
    const page = makePrimoDownloadPage(popup);
    browser.runJob.mockImplementation(async (callback) => callback(page));

    await expect(
      scrapeDownload(
        { href: "https://primo.nlr.ru/discovery/fulldisplay?docid=123" },
        path.join(runDirectory, "unsafe-viewer.pdf")
      )
    ).rejects.toThrow("exact Vivaldi document route");
  });

  it("rejects a prepared part link outside the Vivaldi document", async () => {
    const popup = makeVivaldiPage({
      partHref: "https://vivaldi.nlr.ru/pm000053467/partfile?part=0",
    });
    const page = makePrimoDownloadPage(popup);
    browser.runJob.mockImplementation(async (callback) => callback(page));

    await expect(
      scrapeDownload(
        { href: "https://primo.nlr.ru/discovery/fulldisplay?docid=123" },
        path.join(runDirectory, "unsafe-part.pdf")
      )
    ).rejects.toThrow("Vivaldi");
  });

  it("rejects a prepared part popup for a different Vivaldi document", async () => {
    const partPopup = makePartDownloadPopup({
      url: "https://vivaldi.nlr.ru/pm000053467/partfile?part=0",
    });
    const popup = makeVivaldiPage({ downloadMode: "popup", partPopup });
    const page = makePrimoDownloadPage(popup);
    browser.runJob.mockImplementation(async (callback) => callback(page));

    await expect(
      scrapeDownload(
        { href: "https://primo.nlr.ru/discovery/fulldisplay?docid=123" },
        path.join(runDirectory, "unsafe-part-popup.pdf")
      )
    ).rejects.toThrow("exact Vivaldi part URL");
  });

  it("rejects an unsafe Vivaldi preparation endpoint", async () => {
    const popup = makeVivaldiPage({
      dialogAttributes: {
        "data-prepare-download-url": "https://attacker.example/prepare",
      },
    });
    const page = makePrimoDownloadPage(popup);
    browser.runJob.mockImplementation(async (callback) => callback(page));

    await expect(
      scrapeDownload(
        { href: "https://primo.nlr.ru/discovery/fulldisplay?docid=123" },
        path.join(runDirectory, "unsafe-endpoint.pdf")
      )
    ).rejects.toThrow("data-prepare-download-url");
  });
});

function makeMetadataPage(finalUrl) {
  return {
    goto: vi.fn(),
    url: () => finalUrl,
    getByRole: vi.fn(() => ({ isVisible: vi.fn().mockResolvedValue(false) })),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn((selector) => {
      if (selector === ".results-count")
        return { textContent: vi.fn().mockResolvedValue("1 результат") };
      return { count: vi.fn().mockResolvedValue(1) };
    }),
  };
}

function makeVivaldiPage({
  initialUrl = "https://vivaldi.nlr.ru/pm000053466/view",
  partHref = "https://vivaldi.nlr.ru/pm000053466/partfile?part=0",
  partCount = 1,
  partDownloads = null,
  downloadMode = "direct",
  partPopup = null,
  dialogAttributes = {},
} = {}) {
  let currentUrl = initialUrl;
  const fakeDownloads = (partDownloads ?? [Buffer.from("%PDF-1.7 test document")]).map(
    (bytes, index) => ({
      url: () => partHref.replace("part=0", `part=${index}`),
      saveAs: vi.fn(async (filePath) => {
        await fs.writeFile(filePath, bytes);
      }),
    })
  );
  const dialog = {
    getAttribute: vi.fn((name) => {
      if (Object.hasOwn(dialogAttributes, name)) return dialogAttributes[name];
      if (name === "data-partscount") return String(partCount);
      if (name === "data-register-url") return "/pm000053466/registerdownload";
      if (name === "data-prepare-download-url") return "/pm000053466/preparedownload";
      if (name === "data-part-download-url") return "/pm000053466/partfile";
      if (name === "data-cancel-url") return "/pm000053466/canceldownload";
      if (name === "data-keep-process-alive-url") {
        return "/pm000053466/keepdownloadprocessalive";
      }
      return null;
    }),
  };
  const partClicks = [];
  const partLinks = Array.from({ length: partCount }, (_, index) => ({
    waitFor: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn().mockResolvedValue(partHref.replace("part=0", `part=${index}`)),
    click: vi.fn(async () => partClicks.push(index)),
  }));
  const partLink = {
    first: vi.fn(() => partLinks[0]),
    nth: vi.fn((index) => partLinks[index]),
  };
  let nextDownload = 0;
  const page = {
    goto: vi.fn(async (url) => {
      currentUrl = url;
    }),
    url: () => currentUrl,
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    getByRole: vi.fn((role, options) => {
      if (role === "link" && options?.name === "Карточка") {
        return {
          click: vi.fn(async () => {
            currentUrl = "https://vivaldi.nlr.ru/pm000053466/details";
          }),
        };
      }
      return { click: vi.fn().mockResolvedValue(undefined) };
    }),
    locator: vi.fn((selector) => {
      if (selector === "#download-dialog") return dialog;
      if (selector === "#progressbar") {
        return {
          getAttribute: vi.fn().mockResolvedValue("/pm000053466/downloadprogress"),
        };
      }
      if (selector === ".btn-download-part") return partLink;
      return { click: vi.fn().mockResolvedValue(undefined) };
    }),
    waitForEvent: vi.fn((event) => {
      if (event === "download") {
        return downloadMode === "direct"
          ? Promise.resolve(fakeDownloads[nextDownload++])
          : new Promise(() => {});
      }
      if (event === "popup") return Promise.resolve(partPopup);
      return Promise.resolve(null);
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  page.__fakeDownload = fakeDownloads[0];
  page.partClicks = partClicks;
  return page;
}

async function makePdfBytes(text) {
  const document = await PDFDocument.create();
  const page = document.addPage([200, 200]);
  page.drawText(text, { x: 20, y: 100 });
  return Buffer.from(await document.save());
}

function makePartDownloadPopup({
  url = "https://vivaldi.nlr.ru/pm000053466/partfile?part=0",
} = {}) {
  const fakeDownload = {
    url: () => url,
    saveAs: vi.fn(async (filePath) => {
      await fs.writeFile(filePath, "%PDF-1.7 popup document");
    }),
  };
  return {
    url: () => url,
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForEvent: vi.fn((event) =>
      event === "download" ? Promise.resolve(fakeDownload) : Promise.resolve(null)
    ),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makePrimoDownloadPage(popup) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    url: () => "https://primo.nlr.ru/discovery/fulldisplay?docid=07NLR_LMS022470404",
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForEvent: vi.fn((event) =>
      event === "popup" ? Promise.resolve(popup) : Promise.resolve(null)
    ),
    getByLabel: vi.fn(() => ({ click: vi.fn().mockResolvedValue(undefined) })),
  };
}
