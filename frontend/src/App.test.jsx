import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import AppThemeProvider from "./ThemeContext";
import { addQuery, fetchQueue } from "./api/queue.api.js";
import { createTestQueryClient } from "./test/test-utils.jsx";

vi.mock("./api/queue.api.js", () => ({
  addQuery: vi.fn(),
  fetchQueue: vi.fn(),
}));

vi.mock("./components/QueueList", () => ({
  default: ({ queue, onRetryPending, onDismissPending }) => (
    <ul data-testid="queue-list">
      {queue.map((item) => (
        <li key={item.id}>
          <span>{item.pageUrl}</span>
          {item.pendingError ? <span>{item.pendingError}</span> : null}
          {item.isPending ? (
            <>
              <button onClick={() => onRetryPending?.(item.pageUrl)}>
                Retry failed submission
              </button>
              <button onClick={() => onDismissPending?.(item.pageUrl)}>
                Dismiss failed submission
              </button>
            </>
          ) : null}
        </li>
      ))}
    </ul>
  ),
}));

function renderApp(queryClient = createTestQueryClient()) {
  return render(
    <QueryClientProvider client={queryClient}>
      <AppThemeProvider>
        <App />
      </AppThemeProvider>
    </QueryClientProvider>
  );
}

describe("App queue behavior baseline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchQueue.mockResolvedValue([]);
  });

  it("keeps a failed optimistic add visible with its server error", async () => {
    const user = userEvent.setup();
    const url = "https://primo.nlr.ru/discovery/search?query=failed";
    addQuery.mockRejectedValueOnce({ response: { data: { error: "URL rejected" } } });

    renderApp();
    await user.type(screen.getByPlaceholderText("https://primo.nlr.ru"), url);
    await user.click(screen.getByRole("button", { name: "Add URL" }));

    expect(await screen.findByText(url)).toBeInTheDocument();
    expect(await screen.findByText("URL rejected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry failed submission" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss failed submission" })).toBeInTheDocument();
  });

  it("keeps a structured partial-add failure actionable", async () => {
    const user = userEvent.setup();
    const url = "https://primo.nlr.ru/discovery/search?query=partial";
    addQuery.mockResolvedValueOnce({
      queued: [],
      failed: [{ url, error: "The URL could not be queued" }],
      queue: [],
    });

    renderApp();
    await user.type(screen.getByPlaceholderText("https://primo.nlr.ru"), url);
    await user.click(screen.getByRole("button", { name: "Add URL" }));

    expect(await screen.findByText("The URL could not be queued")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry failed submission" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss failed submission" })).toBeInTheDocument();
    expect(screen.queryByText("Query added to the queue.")).not.toBeInTheDocument();
  });

  it("retries a failed provisional add and removes it after queueing", async () => {
    const user = userEvent.setup();
    const url = "https://primo.nlr.ru/discovery/search?query=retry";
    addQuery
      .mockRejectedValueOnce({ response: { data: { error: "Temporary failure" } } })
      .mockResolvedValueOnce({ queued: [{ url, id: 12 }], failed: [], queue: [] });

    renderApp();
    await user.type(screen.getByPlaceholderText("https://primo.nlr.ru"), url);
    await user.click(screen.getByRole("button", { name: "Add URL" }));
    await screen.findByText("Temporary failure");

    await user.click(screen.getByRole("button", { name: "Retry failed submission" }));

    await waitFor(() => expect(addQuery).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(url)).not.toBeInTheDocument());
  });

  it("dismisses a failed provisional add", async () => {
    const user = userEvent.setup();
    const url = "https://primo.nlr.ru/discovery/search?query=dismiss";
    addQuery.mockRejectedValueOnce(new Error("Rejected by server"));

    renderApp();
    await user.type(screen.getByPlaceholderText("https://primo.nlr.ru"), url);
    await user.click(screen.getByRole("button", { name: "Add URL" }));
    await screen.findByText("Rejected by server");

    await user.click(screen.getByRole("button", { name: "Dismiss failed submission" }));

    await waitFor(() => expect(screen.queryByText(url)).not.toBeInTheDocument());
  });

  it("removes a successful submission from pending state instead of only hiding it", async () => {
    const user = userEvent.setup();
    const url = "https://primo.nlr.ru/discovery/search?query=success";
    addQuery.mockResolvedValueOnce({
      queued: [{ url, id: 13 }],
      failed: [],
      queue: [{ id: 13, pageUrl: url, status: "pending" }],
    });
    fetchQueue.mockResolvedValue([]);

    renderApp();
    await user.type(screen.getByPlaceholderText("https://primo.nlr.ru"), url);
    await user.click(screen.getByRole("button", { name: "Add URL" }));

    await waitFor(() => expect(screen.queryByText(url)).not.toBeInTheDocument());
  });

  it("keeps cached queue data visible with a warning during a failed refetch", async () => {
    const queryClient = createTestQueryClient();
    const cachedUrl = "https://primo.nlr.ru/discovery/search?query=cached";
    queryClient.setQueryData(
      ["queue"],
      [
        {
          id: 11,
          pageUrl: cachedUrl,
          status: "completed",
          results: 1,
          searchResults: [],
        },
      ]
    );
    fetchQueue.mockRejectedValueOnce(new Error("Redis unavailable"));

    renderApp(queryClient);

    expect(
      await screen.findByText(
        "Unable to refresh the queue. Showing the last available data; retrying…"
      )
    ).toBeInTheDocument();
    expect(screen.getByText(cachedUrl)).toBeInTheDocument();
  });
});
