import React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { deleteQuery, retryQuery, pauseQuery, pauseItem, deleteItem } from "../api/queue.api.js";

/**
 * @typedef {{ open: boolean, message: string, severity: 'success' | 'error' }} SnackbarState
 */

/**
 * Provides mutations for delete, retry, pause, and per-item actions, plus shared snackbar state.
 * Control mutations leave the queue cache untouched while the request is in flight. The server
 * remains authoritative, and a successful/failed request is followed by a refetch. This avoids
 * restoring an old whole-queue snapshot over a concurrent successful mutation.
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
    onError: (err) => {
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
    onError: (err) => {
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
    onError: (err) => {
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
    onError: (err) => {
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
    onError: (err) => {
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
    deletingItemId: deleteItemMutation.isPending
      ? (deleteItemMutation.variables?.itemId ?? null)
      : null,
    snackbar,
    closeSnackbar,
  };
}
