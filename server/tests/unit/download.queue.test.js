import { describe, expect, it, vi } from "vitest";

const downloadQueue = vi.hoisted(() => ({
  getJobs: vi.fn(),
}));

vi.mock("../../queue.js", () => ({ downloadQueue }));

const { cancelDownloadJobs } = await import("../../queues/download.queue.js");

describe("download job lifecycle helpers", () => {
  it("cancels the base job and every retry without guessing retry suffixes", async () => {
    const jobs = [
      makeJob({ itemId: 7 }, "waiting"),
      makeJob({ itemId: 7, attempt: 2 }, "delayed"),
      makeJob({ itemId: 7, attempt: 11 }, "prioritized"),
      makeJob({ itemId: 8 }, "waiting"),
    ];
    downloadQueue.getJobs.mockResolvedValue(jobs);

    await expect(cancelDownloadJobs(7)).resolves.toBe(3);
    expect(jobs[0].remove).toHaveBeenCalledOnce();
    expect(jobs[1].remove).toHaveBeenCalledOnce();
    expect(jobs[2].remove).toHaveBeenCalledOnce();
    expect(jobs[3].remove).not.toHaveBeenCalled();
  });
});

function makeJob(data, state) {
  return {
    data,
    getState: vi.fn().mockResolvedValue(state),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}
