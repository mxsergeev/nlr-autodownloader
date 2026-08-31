import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import QueueItem from "./QueueItem";
import { fetchQueueItem } from "../api/queue.api.js";
import { TestProviders } from "../test/test-utils.jsx";

const clipboard = vi.hoisted(() => ({ copyToClipboard: vi.fn() }));

vi.mock("../utils/clipboard.js", () => clipboard);

vi.mock("../api/queue.api.js", () => ({
  fetchQueueItem: vi.fn(),
}));

vi.mock("./DocumentList", () => ({
  default: () => null,
}));

const baseProps = {
  index: 0,
  isDeleting: false,
  isRetrying: false,
  isPausing: false,
  pausingItemId: null,
  deletingItemId: null,
  onRequestDelete: vi.fn(),
  onRetry: vi.fn(),
  onRetryPending: vi.fn(),
  onDismissPending: vi.fn(),
  onPause: vi.fn(),
  onPauseItem: vi.fn(),
  onDeleteItem: vi.fn(),
};

describe("QueueItem behavior baseline", () => {
  beforeEach(() => vi.clearAllMocks());

  it("offers pause while metadata is being fetched", async () => {
    const user = userEvent.setup();
    render(
      <TestProviders>
        <QueueItem
          {...baseProps}
          item={{
            id: 9,
            pageUrl: "https://primo.nlr.ru/discovery/search?query=metadata",
            status: "fetching_metadata",
            results: null,
          }}
        />
      </TestProviders>
    );

    await user.click(screen.getByRole("button", { name: "Pause item" }));
    expect(baseProps.onPause).toHaveBeenCalledWith(9);
  });

  it("reports clipboard failures instead of claiming the URL was copied", async () => {
    const user = userEvent.setup();
    clipboard.copyToClipboard.mockRejectedValueOnce(new Error("Clipboard denied"));
    render(
      <TestProviders>
        <QueueItem
          {...baseProps}
          item={{
            id: 10,
            pageUrl: "https://primo.nlr.ru/discovery/search?query=clipboard",
            status: "completed",
            results: 1,
          }}
        />
      </TestProviders>
    );

    await user.click(screen.getByRole("button", { name: "Copy URL" }));

    expect(await screen.findByText("Unable to copy URL: Clipboard denied")).toBeInTheDocument();
    expect(screen.queryByText("Copied!")).not.toBeInTheDocument();
  });

  it("exposes retry and delete controls for a persisted failed query", async () => {
    const user = userEvent.setup();
    render(
      <TestProviders>
        <QueueItem
          {...baseProps}
          item={{
            id: 7,
            pageUrl: "https://primo.nlr.ru/discovery/search?query=failed",
            status: "search_failed",
            results: null,
            searchResults: [],
          }}
        />
      </TestProviders>
    );

    await user.click(screen.getByRole("button", { name: "Retry item" }));
    await user.click(screen.getByRole("button", { name: "Delete item" }));

    expect(baseProps.onRetry).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }));
    expect(baseProps.onRequestDelete).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      expect.any(String)
    );
  });

  it("exposes retry and dismiss controls for a failed optimistic row", async () => {
    const user = userEvent.setup();
    render(
      <TestProviders>
        <QueueItem
          {...baseProps}
          item={{
            id: "pending-https://primo.nlr.ru/failed",
            pageUrl: "https://primo.nlr.ru/failed",
            status: "search_failed",
            isPending: true,
            pendingStatus: "error",
            pendingError: "URL rejected",
            results: null,
            searchResults: [],
          }}
        />
      </TestProviders>
    );

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(baseProps.onRetryPending).toHaveBeenCalledWith("https://primo.nlr.ru/failed");
    expect(baseProps.onDismissPending).toHaveBeenCalledWith("https://primo.nlr.ru/failed");
  });

  it("surfaces detail-fetch errors and offers a retry", async () => {
    fetchQueueItem.mockRejectedValueOnce(new Error("detail service unavailable"));
    render(
      <TestProviders>
        <QueueItem
          {...baseProps}
          item={{
            id: 8,
            pageUrl: "https://primo.nlr.ru/discovery/search?query=details",
            status: "downloading",
            results: 1,
            downloaded: 0,
            searchResults: [],
          }}
        />
      </TestProviders>
    );

    await waitFor(() => expect(fetchQueueItem).toHaveBeenCalledWith(8));
    expect(screen.getByText("primo.nlr.ru")).toBeInTheDocument();
    expect(await screen.findByText("detail service unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
