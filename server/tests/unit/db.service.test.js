import { afterEach, describe, expect, it } from "vitest";
import { prisma, saveSearchResults, upsertMetadata } from "../../services/db.service.js";
import { UrlValidationError } from "../../services/url.service.js";
import { makeQueryFixture, makeSearchResultFixture } from "../fixtures/query.fixture.js";

describe("database service characterization", () => {
  afterEach(async () => {
    await prisma.searchResult.deleteMany();
    await prisma.query.deleteMany();
  });

  it("preserves an existing search-result status while refreshing its display fields", async () => {
    const fixture = makeQueryFixture({ results: 1 });
    const query = await upsertMetadata({ url: fixture.pageUrl }, fixture);
    await saveSearchResults({ queryId: query.id }, [makeSearchResultFixture()]);

    const original = await prisma.searchResult.findFirstOrThrow();
    await prisma.searchResult.update({ where: { id: original.id }, data: { status: "completed" } });
    await saveSearchResults({ queryId: query.id }, [
      makeSearchResultFixture({ title: "Updated title", fileName: "Updated title" }),
    ]);

    const updated = await prisma.searchResult.findFirstOrThrow();
    expect(updated.status).toBe("completed");
    expect(updated.title).toBe("Updated title");
  });

  it("does not persist Vivaldi URLs as query or search-result input", async () => {
    await expect(
      upsertMetadata({ url: "https://vivaldi.nlr.ru/pm000053466/details" }, makeQueryFixture())
    ).rejects.toBeInstanceOf(UrlValidationError);

    const fixture = makeQueryFixture();
    const query = await upsertMetadata({ url: fixture.pageUrl }, fixture);
    await expect(
      saveSearchResults({ queryId: query.id }, [
        makeSearchResultFixture({ href: "https://vivaldi.nlr.ru/pm000053466/details" }),
      ])
    ).rejects.toBeInstanceOf(UrlValidationError);
  });
});
