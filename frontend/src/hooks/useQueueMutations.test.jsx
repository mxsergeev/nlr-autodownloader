import React from "react";
import { renderHook, waitFor, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQueueMutations } from "./useQueueMutations";
import { deleteQuery, pauseQuery } from "../api/queue.api.js";
import { createTestQueryClient, TestProviders } from "../test/test-utils.jsx";
import { deferred } from "../test/deferred.js";

vi.mock("../api/queue.api.js", () => ({
  deleteQuery: vi.fn(),
  retryQuery: vi.fn(),
  pauseQuery: vi.fn(),
  pauseItem: vi.fn(),
  deleteItem: vi.fn(),
}));

describe("queue mutation behavior", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not roll back a concurrent successful mutation when another action fails", async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(
      ["queue"],
      [
        { id: 1, status: "completed" },
        { id: 2, status: "pending" },
      ]
    );
    const deleteRequest = deferred();
    const pauseRequest = deferred();
    deleteQuery.mockReturnValueOnce(deleteRequest.promise);
    pauseQuery.mockReturnValueOnce(pauseRequest.promise);

    const { result } = renderHook(() => useQueueMutations(), {
      wrapper: ({ children }) => (
        <TestProviders queryClient={queryClient}>{children}</TestProviders>
      ),
    });

    act(() => result.current.deleteMutation.mutate(1));
    await waitFor(() => expect(deleteQuery).toHaveBeenCalledWith(1));
    expect(queryClient.getQueryData(["queue"])).toEqual([
      { id: 1, status: "completed" },
      { id: 2, status: "pending" },
    ]);

    act(() => result.current.pauseMutation.mutate(2));
    await waitFor(() => expect(pauseQuery).toHaveBeenCalledWith(2));
    expect(queryClient.getQueryData(["queue"])).toEqual([
      { id: 1, status: "completed" },
      { id: 2, status: "pending" },
    ]);

    await act(async () => {
      pauseRequest.resolve({ paused: true });
      await pauseRequest.promise;
    });
    await act(async () => {
      deleteRequest.reject(new Error("delete failed"));
      await expect(deleteRequest.promise).rejects.toThrow("delete failed");
    });

    await waitFor(() => expect(result.current.deleteMutation.isPending).toBe(false));
    expect(queryClient.getQueryData(["queue"])).toEqual([
      { id: 1, status: "completed" },
      { id: 2, status: "pending" },
    ]);
  });
});
