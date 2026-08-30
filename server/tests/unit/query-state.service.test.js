import { afterEach, describe, expect, it } from "vitest";
import {
  getMetadataById,
  prisma,
  saveSearchResults,
  upsertMetadata,
} from "../../services/db.service.js";
import {
  deleteSearchResultAndReconcile,
  setSearchResultStatus,
} from "../../services/query-state.service.js";
import { makeQueryFixture, makeSearchResultFixture } from "../fixtures/query.fixture.js";
import { deferred } from "../helpers/deferred.js";

describe("query state reconciliation", () => {
  afterEach(async () => {
    await prisma.searchResult.deleteMany();
    await prisma.query.deleteMany();
  });

  it("derives counters, progress, and parent status from SearchResult rows", async () => {
    const query = await createQuery();
    const [first, second] = await getItems(query.id);

    await setSearchResultStatus(first.id, "completed");

    let state = await getMetadataById(query.id);
    expect(state).toMatchObject({
      results: 2,
      downloaded: 1,
      downloadProgress: "50%",
      status: "download_queued",
    });

    await setSearchResultStatus(second.id, "completed");

    state = await getMetadataById(query.id);
    expect(state).toMatchObject({
      results: 2,
      downloaded: 2,
      downloadProgress: "100%",
      status: "completed",
    });
  });

  it("keeps an explicitly paused parent paused while reconciling children", async () => {
    const query = await createQuery();
    const [first, second] = await getItems(query.id);

    await prisma.query.update({ where: { id: query.id }, data: { status: "paused" } });
    await setSearchResultStatus(first.id, "completed");
    await setSearchResultStatus(second.id, "pending");

    await expect(getMetadataById(query.id)).resolves.toMatchObject({
      results: 2,
      downloaded: 1,
      downloadProgress: "50%",
      status: "paused",
    });
  });

  it("does not leave the parent downloading when its last active child is paused", async () => {
    const query = await createQuery();
    const [first, second] = await getItems(query.id);

    await setSearchResultStatus(first.id, "completed");
    await setSearchResultStatus(second.id, "downloading");
    await setSearchResultStatus(second.id, "paused", { expectedStatuses: ["downloading"] });

    await expect(getMetadataById(query.id)).resolves.toMatchObject({
      status: "download_queued",
      results: 2,
      downloaded: 1,
      downloadProgress: "50%",
    });
  });

  it("converges to completed when two item completions race in either order", async () => {
    const query = await createQuery();
    const [first, second] = await getItems(query.id);

    const forward = await runConcurrentTransitions(query.id, [
      { itemId: first.id, status: "completed" },
      { itemId: second.id, status: "completed" },
    ]);

    await resetItems(query.id);

    const reverse = await runConcurrentTransitions(query.id, [
      { itemId: second.id, status: "completed" },
      { itemId: first.id, status: "completed" },
    ]);

    expect(projectState(forward)).toEqual(projectState(reverse));
    expect(projectState(reverse)).toEqual({
      query: {
        status: "completed",
        results: 2,
        downloaded: 2,
        downloadProgress: "100%",
      },
      items: ["completed", "completed"],
    });
  });

  it("converges to blocked when one success and one permanent failure race in either order", async () => {
    const query = await createQuery();
    const [first, second] = await getItems(query.id);

    const successThenFailure = await runConcurrentTransitions(query.id, [
      { itemId: first.id, status: "completed" },
      { itemId: second.id, status: "download_blocked" },
    ]);

    await resetItems(query.id);

    const failureThenSuccess = await runConcurrentTransitions(query.id, [
      { itemId: second.id, status: "download_blocked" },
      { itemId: first.id, status: "completed" },
    ]);

    expect(projectState(successThenFailure)).toEqual(projectState(failureThenSuccess));
    expect(projectState(failureThenSuccess)).toEqual({
      query: {
        status: "download_blocked",
        results: 2,
        downloaded: 1,
        downloadProgress: "50%",
      },
      items: ["completed", "download_blocked"],
    });
  });

  it("reconciles counters after an item is removed instead of decrementing snapshots", async () => {
    const query = await createQuery();
    const [first, second] = await getItems(query.id);

    await setSearchResultStatus(first.id, "completed");
    await setSearchResultStatus(second.id, "completed");
    await deleteSearchResultAndReconcile(first.id);

    await expect(getMetadataById(query.id)).resolves.toMatchObject({
      results: 1,
      downloaded: 1,
      downloadProgress: "100%",
      status: "completed",
    });
  });

  it("finishes a download-stage query when its final child is removed", async () => {
    const query = await createQuery();
    const [first, second] = await getItems(query.id);

    await setSearchResultStatus(first.id, "completed");
    await setSearchResultStatus(second.id, "downloading");
    await deleteSearchResultAndReconcile(first.id);
    await deleteSearchResultAndReconcile(second.id);

    await expect(getMetadataById(query.id)).resolves.toMatchObject({
      status: "completed",
      results: 0,
      downloaded: 0,
      downloadProgress: null,
    });
  });
});

async function createQuery() {
  const fixture = makeQueryFixture({
    results: 999,
    downloaded: 999,
    downloadProgress: "100%",
    status: "download_queued",
  });
  const query = await upsertMetadata({ url: fixture.pageUrl }, fixture);

  await saveSearchResults({ queryId: query.id }, [
    makeSearchResultFixture({ href: `${fixture.pageUrl}&docid=first`, fileName: "First" }),
    makeSearchResultFixture({ href: `${fixture.pageUrl}&docid=second`, fileName: "Second" }),
  ]);

  return query;
}

async function getItems(queryId) {
  return prisma.searchResult.findMany({ where: { queryId }, orderBy: { id: "asc" } });
}

async function resetItems(queryId) {
  await prisma.searchResult.updateMany({ where: { queryId }, data: { status: "pending" } });
  await prisma.query.update({
    where: { id: queryId },
    data: { status: "download_queued", results: 999, downloaded: 999, downloadProgress: "100%" },
  });
}

async function runConcurrentTransitions(queryId, transitions) {
  const started = transitions.map(() => deferred());
  const release = deferred();
  const operations = transitions.map(({ itemId, status }, index) =>
    (async () => {
      started[index].resolve();
      await release.promise;
      return setSearchResultStatus(itemId, status);
    })()
  );

  await Promise.all(started.map((barrier) => barrier.promise));
  release.resolve();
  await Promise.all(operations);
  return getMetadataById(queryId);
}

function projectState(state) {
  return {
    query: {
      status: state.status,
      results: state.results,
      downloaded: state.downloaded,
      downloadProgress: state.downloadProgress,
    },
    items: state.searchResults
      .slice()
      .sort((left, right) => left.id - right.id)
      .map((item) => item.status),
  };
}
