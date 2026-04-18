import React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { deleteQuery, retryQuery, pauseQuery, pauseItem, deleteItem } from "../api/queue.api.js";

/**
 * @typedef {{ open: boolean, message: string, severity: 'success' | 'error' }} SnackbarState
 */

/**
 * Provides mutations for delete, retry, pause, and per-item actions, plus shared snackbar state.
 * All mutations update the cache optimistically and sync with the server via onSettled.
 * @returns {{
 *   deleteMutation: import('@tanstack/react-query').UseMutationResult,
 *   retryMutation: import('@tanstack/react-query').UseMutationResult,
 *   pauseMutation: import('@tanstack/react-query').UseMutationResult,
 *   pauseItemMutation: import('@tanstack/react-query').UseMutationResult,
 *   deleteItemMutation: import('@tanstack/react-query').UseMutationResult,
 *   snackbar: SnackbarState,
 *   closeSnackbar: () => void,
 * }}
 */
export function useQueueMutations() {
  const qc = useQueryClient();
  const [snackbar, setSnackbar] = React.useState({ open: false, message: "", severity: "success" });

  const closeSnackbar = () => setSnackbar((s) => ({ ...s, open: false }));

  const deleteMutation = useMutation({
    mutationFn: (id) => deleteQuery(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["queue"] });
      const prev = qc.getQueryData(["queue"]);
      qc.setQueryData(["queue"], (old) => old?.filter((q) => q.id !== id) ?? []);
      return { prev };
    },
    onError: (err, _id, ctx) => {
      qc.setQueryData(["queue"], ctx?.prev);
      setSnackbar({
        open: true,
        message: err?.response?.data?.error || err?.message || "Failed to remove query",
        severity: "error",
      });
    },
    onSuccess: (_, id) => {
      setSnackbar({ open: true, message: `Removed query ${id}`, severity: "success" });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["queue"] }),
  });

  const retryMutation = useMutation({
    mutationFn: (id) => retryQuery(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["queue"] });
      const prev = qc.getQueryData(["queue"]);
      qc.setQueryData(
        ["queue"],
        (old) => old?.map((q) => (q.id === id ? { ...q, status: "fetching_metadata" } : q)) ?? []
      );
      return { prev };
    },
    onError: (err, _id, ctx) => {
      qc.setQueryData(["queue"], ctx?.prev);
      setSnackbar({
        open: true,
        message: err?.response?.data?.error || err?.message || "Failed to retry query",
        severity: "error",
      });
    },
    onSuccess: (_, id) => {
      setSnackbar({ open: true, message: `Retrying query ${id}`, severity: "success" });
    },
    onSettled: (_, __, id) => {
      qc.invalidateQueries({ queryKey: ["queue"] });
      qc.invalidateQueries({ queryKey: ["queue-item", id] });
    },
  });

  const pauseMutation = useMutation({
    mutationFn: (id) => pauseQuery(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["queue"] });
      const prev = qc.getQueryData(["queue"]);
      qc.setQueryData(
        ["queue"],
        (old) =>
          old?.map((q) => {
            if (q.id !== id) return q;
            const nextStatus =
              q.status === "paused"
                ? "downloading"
                : ["downloading", "pending"].includes(q.status)
                  ? "paused"
                  : q.status;
            return { ...q, status: nextStatus };
          }) ?? []
      );
      return { prev };
    },
    onError: (err, _id, ctx) => {
      qc.setQueryData(["queue"], ctx?.prev);
      setSnackbar({
        open: true,
        message: err?.response?.data?.error || err?.message || "Failed to pause/resume query",
        severity: "error",
      });
    },
    onSettled: (_, __, id) => {
      qc.invalidateQueries({ queryKey: ["queue"] });
      qc.invalidateQueries({ queryKey: ["queue-item", id] });
    },
  });

  const pauseItemMutation = useMutation({
    mutationFn: ({ queryId, itemId }) => pauseItem(queryId, itemId),
    onMutate: async ({ queryId, itemId }) => {
      await qc.cancelQueries({ queryKey: ["queue-item", queryId] });
      const prev = qc.getQueryData(["queue-item", queryId]);
      qc.setQueryData(["queue-item", queryId], (old) => {
        if (!old) return old;
        return {
          ...old,
          searchResults: old.searchResults?.map((r) =>
            r.id === itemId ? { ...r, status: r.status === "paused" ? "pending" : "paused" } : r
          ),
        };
      });
      return { prev };
    },
    onError: (err, { queryId }, ctx) => {
      qc.setQueryData(["queue-item", queryId], ctx?.prev);
      setSnackbar({
        open: true,
        message: err?.response?.data?.error || err?.message || "Failed to pause item",
        severity: "error",
      });
    },
    onSettled: (_, __, { queryId }) => {
      qc.invalidateQueries({ queryKey: ["queue"] });
      qc.invalidateQueries({ queryKey: ["queue-item", queryId] });
    },
  });

  const deleteItemMutation = useMutation({
    mutationFn: ({ queryId, itemId }) => deleteItem(queryId, itemId),
    onMutate: async ({ queryId, itemId }) => {
      await qc.cancelQueries({ queryKey: ["queue-item", queryId] });
      const prev = qc.getQueryData(["queue-item", queryId]);
      qc.setQueryData(["queue-item", queryId], (old) => {
        if (!old) return old;
        return {
          ...old,
          searchResults: old.searchResults?.filter((r) => r.id !== itemId),
          results: old.results != null ? old.results - 1 : old.results,
        };
      });
      return { prev };
    },
    onError: (err, { queryId }, ctx) => {
      qc.setQueryData(["queue-item", queryId], ctx?.prev);
      setSnackbar({
        open: true,
        message: err?.response?.data?.error || err?.message || "Failed to remove item",
        severity: "error",
      });
    },
    onSuccess: (_, { itemId }) => {
      setSnackbar({ open: true, message: `Removed item ${itemId}`, severity: "success" });
    },
    onSettled: (_, __, { queryId }) => {
      qc.invalidateQueries({ queryKey: ["queue"] });
      qc.invalidateQueries({ queryKey: ["queue-item", queryId] });
    },
  });

  return {
    deleteMutation,
    retryMutation,
    pauseMutation,
    pauseItemMutation,
    deleteItemMutation,
    snackbar,
    closeSnackbar,
  };
}
