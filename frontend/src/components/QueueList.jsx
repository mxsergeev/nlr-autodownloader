import React from "react";
import { Alert, Box, Snackbar, Typography } from "@mui/material";
import InboxRoundedIcon from "@mui/icons-material/InboxRounded";
import ConfirmDialog from "./ConfirmDialog";
import QueueItem from "./QueueItem";
import { useQueueMutations } from "../hooks/useQueueMutations";

/**
 * @param {{ queue: import('../../../shared/types.js').Query[] }} props
 */
export default function QueueList({ queue }) {
  const {
    deleteMutation,
    retryMutation,
    pauseMutation,
    pauseItemMutation,
    deleteItemMutation,
    snackbar,
    closeSnackbar,
  } = useQueueMutations();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [selectedItem, setSelectedItem] = React.useState(null);

  const requestDelete = React.useCallback((item) => {
    setSelectedItem(item);
    setDialogOpen(true);
  }, []);

  const requestRetry = React.useCallback(
    (item) => {
      setSelectedItem(item);
      retryMutation.mutate(item.id, {
        onSettled: () => setSelectedItem(null),
      });
    },
    [retryMutation]
  );

  const requestPause = React.useCallback(
    (id) => {
      setSelectedItem({ id });
      pauseMutation.mutate(id, {
        onSettled: () => setSelectedItem(null),
      });
    },
    [pauseMutation]
  );

  const requestPauseItem = React.useCallback(
    (queryId, itemId) => {
      pauseItemMutation.mutate({ queryId, itemId });
    },
    [pauseItemMutation]
  );

  const requestDeleteItem = React.useCallback(
    (queryId, itemId) => {
      deleteItemMutation.mutate({ queryId, itemId });
    },
    [deleteItemMutation]
  );

  const confirmDelete = React.useCallback(() => {
    if (!selectedItem?.id) return;
    deleteMutation.mutate(selectedItem.id, {
      onSettled: () => {
        setDialogOpen(false);
        setSelectedItem(null);
      },
    });
  }, [selectedItem, deleteMutation]);

  if (!queue || queue.length === 0) {
    return (
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 1.5,
          py: 8,
          color: "text.secondary",
        }}
      >
        <InboxRoundedIcon sx={{ fontSize: 40, opacity: 0.4 }} />
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          The queue is empty
        </Typography>
        <Typography variant="caption" sx={{ opacity: 0.7 }}>
          Add a Primo URL above to get started.
        </Typography>
      </Box>
    );
  }

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1.5 }}>
        <Typography
          variant="body2"
          sx={{ fontWeight: 600, color: "text.secondary", letterSpacing: "0.04em" }}
        >
          QUEUE
        </Typography>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {queue.length} {queue.length === 1 ? "item" : "items"}
        </Typography>
      </Box>

      <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {queue.map((item, index) => (
          <QueueItem
            key={item.id ?? item.pageUrl ?? `queue-item-${index}`}
            item={item}
            index={index}
            isDeleting={deleteMutation.isPending && selectedItem?.id === item.id}
            isRetrying={retryMutation.isPending && selectedItem?.id === item.id}
            isPausing={pauseMutation.isPending && selectedItem?.id === item.id}
            onRequestDelete={requestDelete}
            onRetry={requestRetry}
            onPause={requestPause}
            onPauseItem={requestPauseItem}
            onDeleteItem={requestDeleteItem}
          />
        ))}
      </Box>

      <ConfirmDialog
        open={dialogOpen}
        title="Remove query"
        content="Are you sure you want to remove this query from the queue? This action cannot be undone."
        itemLabel={selectedItem?.pageUrl ?? `Query #${selectedItem?.id ?? ""}`}
        loading={deleteMutation.isPending}
        onClose={() => {
          setDialogOpen(false);
          setSelectedItem(null);
        }}
        onConfirm={confirmDelete}
        confirmText="Remove"
        cancelText="Cancel"
      />

      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={closeSnackbar}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert onClose={closeSnackbar} severity={snackbar.severity} sx={{ width: "100%" }}>
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
}
