import React from "react";
import { List } from "react-window";
import {
  Box,
  CircularProgress,
  Divider,
  IconButton,
  ListItem,
  ListItemText,
  Tooltip,
  Typography,
} from "@mui/material";
import DescriptionRoundedIcon from "@mui/icons-material/DescriptionRounded";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import PauseRoundedIcon from "@mui/icons-material/PauseRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import { downloadItem } from "../api/queue.api.js";
import { copyToClipboard } from "../utils/clipboard.js";
import StatusChip from "./StatusChip";

const ITEM_HEIGHT = 60;

function DocumentRow({
  index,
  style,
  documents,
  queryId,
  onPauseItem,
  onDeleteItem,
  pausingItemId,
}) {
  const doc = documents[index];
  const isPaused = doc.status === "paused";
  const canPause = ["pending", "paused"].includes(doc.status);
  const canDownload = doc.status === "completed";
  const isPausing = pausingItemId === doc.id;
  const [copied, setCopied] = React.useState(false);
  const [isDownloading, setIsDownloading] = React.useState(false);
  const [downloadError, setDownloadError] = React.useState(null);

  const handleCopyUrl = (e) => {
    e.stopPropagation();
    if (!doc.href) return;
    copyToClipboard(doc.href).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleDownload = async (e) => {
    e.stopPropagation();
    if (isDownloading) return;
    setIsDownloading(true);
    setDownloadError(null);
    try {
      const { blob, filename } = await downloadItem(queryId, doc.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      let message = "Download failed";
      if (err?.response?.data instanceof Blob) {
        try {
          const text = await err.response.data.text();
          const json = JSON.parse(text);
          message = json.error || message;
        } catch {
          // ignore parse error
        }
      } else {
        message = err?.response?.data?.error || err?.message || message;
      }
      setDownloadError(message);
    } finally {
      setIsDownloading(false);
    }
  };

  const docLabel = doc.fileName ?? doc.title ?? doc.href ?? "Untitled";

  return (
    <Box style={style} sx={{ px: 1, py: 0.5, boxSizing: "border-box" }}>
      <ListItem
        sx={{
          px: 1,
          py: 0.5,
          alignItems: "center",
          borderBottom: index < documents.length - 1 ? "1px solid" : "none",
          borderColor: "divider",
        }}
        secondaryAction={
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            <StatusChip status={doc.status} />
            {canDownload && (
              <Tooltip title={downloadError ?? (isDownloading ? "Downloading…" : "Download file")}>
                <IconButton
                  size="small"
                  color={downloadError ? "error" : "primary"}
                  disabled={isDownloading}
                  onClick={handleDownload}
                >
                  {isDownloading ? (
                    <CircularProgress size={14} />
                  ) : (
                    <DownloadRoundedIcon sx={{ fontSize: 14 }} />
                  )}
                </IconButton>
              </Tooltip>
            )}
            {canPause && (
              <Tooltip title={isPaused ? "Resume" : "Pause"}>
                <IconButton
                  size="small"
                  disabled={isPausing}
                  onClick={(e) => {
                    e.stopPropagation();
                    onPauseItem?.(queryId, doc.id);
                  }}
                >
                  {isPausing ? (
                    <CircularProgress size={14} />
                  ) : isPaused ? (
                    <PlayArrowRoundedIcon sx={{ fontSize: 14 }} />
                  ) : (
                    <PauseRoundedIcon sx={{ fontSize: 14 }} />
                  )}
                </IconButton>
              </Tooltip>
            )}
            <Tooltip title="Remove">
              <IconButton
                size="small"
                color="error"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteItem?.(queryId, doc.id, docLabel);
                }}
              >
                <DeleteRoundedIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          </Box>
        }
      >
        <ListItemText
          sx={{ overflow: "hidden", minWidth: 0 }}
          primary={
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, overflow: "hidden" }}>
              {doc.href && (
                <Tooltip title={copied ? "Copied!" : "Copy URL"}>
                  <IconButton
                    size="small"
                    sx={{ p: 0.25, flexShrink: 0, color: "text.secondary" }}
                    onClick={handleCopyUrl}
                  >
                    <ContentCopyRoundedIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                </Tooltip>
              )}
              <Tooltip title={docLabel} placement="bottom-start">
                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: 500,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: "0.85rem",
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {index + 1}. {docLabel}
                </Typography>
              </Tooltip>
            </Box>
          }
        />
      </ListItem>
    </Box>
  );
}

// Module-level component — stable reference, receives data via rowProps from react-window.
function Row({ index, style, documents, queryId, onPauseItem, onDeleteItem, pausingItemId }) {
  return (
    <DocumentRow
      index={index}
      style={style}
      documents={documents}
      queryId={queryId}
      onPauseItem={onPauseItem}
      onDeleteItem={onDeleteItem}
      pausingItemId={pausingItemId}
    />
  );
}

/**
 * Document list for a queue item, rendered inside a Drawer (not inside a Collapse).
 * Uses a ResizeObserver to measure the available container height so react-window
 * virtualizes correctly regardless of viewport size.
 * @param {{
 *   queryId: number,
 *   results: number | null,
 *   searchResults: Array | undefined,
 *   isLoading: boolean,
 *   pausingItemId: number | null,
 *   onPauseItem: (queryId: number, itemId: number) => void,
 *   onDeleteItem: (queryId: number, itemId: number) => void,
 * }} props
 */
function DocumentList({
  queryId,
  results,
  searchResults,
  isLoading,
  onPauseItem,
  onDeleteItem,
  pausingItemId,
}) {
  const documents = React.useMemo(
    () => (Array.isArray(searchResults) ? searchResults : []),
    [searchResults]
  );
  const documentCount = searchResults?.length > 0 ? searchResults.length : (results ?? "N/A");

  // Measure the scrollable container height so react-window gets the correct defaultHeight.
  // This is necessary because the Drawer opens after mount and the height is CSS-driven.
  const containerRef = React.useRef(null);
  const [listHeight, setListHeight] = React.useState(() => Math.max(200, window.innerHeight - 130));

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setListHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const rowProps = React.useMemo(
    () => ({ documents, queryId, onPauseItem, onDeleteItem, pausingItemId }),
    [documents, queryId, onPauseItem, onDeleteItem, pausingItemId]
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Box sx={{ px: 2, py: 1 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <DescriptionRoundedIcon fontSize="small" sx={{ color: "text.secondary" }} />
          <Typography variant="subtitle2" sx={{ color: "text.secondary", fontWeight: 600 }}>
            Documents ({documentCount})
          </Typography>
        </Box>
      </Box>
      <Divider />
      <Box ref={containerRef} sx={{ flex: 1, overflow: "hidden" }}>
        {isLoading ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
            <CircularProgress size={24} thickness={3} />
          </Box>
        ) : documents.length === 0 ? (
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", display: "block", px: 2, pt: 2 }}
          >
            {results === 0
              ? "No documents found for this query."
              : results != null
                ? "Getting document details..."
                : "No document details available."}
          </Typography>
        ) : (
          <List
            defaultHeight={listHeight}
            rowCount={documents.length}
            rowHeight={ITEM_HEIGHT}
            rowComponent={Row}
            rowProps={rowProps}
            style={{ width: "100%", overflowY: "auto" }}
          />
        )}
      </Box>
    </Box>
  );
}

export default React.memo(DocumentList);
