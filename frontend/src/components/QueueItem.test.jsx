import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import QueueItem from "./QueueItem";
import { fetchQueueItem } from "../api/queue.api.js";
import { TestProviders } from "../test/test-utils.jsx";

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
  onRequestDelete: vi.fn(),
  onRetry: vi.fn(),
  onPause: vi.fn(),
  onPauseItem: vi.fn(),
  onDeleteItem: vi.fn(),
};

describe("QueueItem behavior baseline", () => {
  beforeEach(() => vi.clearAllMocks());

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

  it("keeps retry and delete disabled for a failed optimistic row", () => {
    render(
      <TestProviders>
        <QueueItem
          {...baseProps}
          item={{
            id: "pending-https://primo.nlr.ru/failed",
            pageUrl: "https://primo.nlr.ru/failed",
            status: "search_failed",
            isPending: true,
            pendingError: "URL rejected",
            results: null,
            searchResults: [],
          }}
        />
      </TestProviders>
    );

    expect(screen.getByRole("button", { name: "Retry item" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete item" })).toBeDisabled();
  });

  it("does not surface detail-fetch errors in the current card UI", async () => {
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
    expect(screen.queryByText("detail service unavailable")).not.toBeInTheDocument();
  });
});
