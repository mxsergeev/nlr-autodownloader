import React from "react";
import { render, screen } from "@testing-library/react";
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
  default: ({ queue }) => (
    <ul data-testid="queue-list">
      {queue.map((item) => (
        <li key={item.id}>
          <span>{item.pageUrl}</span>
          {item.pendingError ? <span>{item.pendingError}</span> : null}
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
  });

  it("currently replaces cached queue data with an error during a failed refetch", async () => {
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

    expect(await screen.findByText("Failed to load queue. Retrying…")).toBeInTheDocument();
    expect(screen.queryByText(cachedUrl)).not.toBeInTheDocument();
  });
});
