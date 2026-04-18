import React from "react";
import { List } from "react-window";
import {
  Box,
  CircularProgress,
  Collapse,
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
import StatusChip from "./StatusChip";

const ITEM_HEIGHT = 60;

function DocumentRow({ index, style, documents, queryId, onPauseItem, onDeleteItem }) {
  const doc = documents[index];
  const isPaused = doc.status === "paused";
  const canPause = ["pending", "paused"].includes(doc.status);
  const canDownload = doc.status === "completed";
  const [copied, setCopied] = React.useState(false);
  const [isDownloading, setIsDownloading] = React.useState(false);

  const handleCopyUrl = (e) => {
    e.stopPropagation();
    if (!doc.href) return;
    navigator.clipboard.writeText(doc.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleDownload = async (e) => {
    e.stopPropagation();
    if (isDownloading) return;
    setIsDownloading(true);
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
    } catch {
      // silently fail — the button will just stop spinning
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
          border: index < documents.length - 1 ? "1px solid" : "none",
          borderColor: "divider",
        }}
        secondaryAction={
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            <StatusChip status={doc.status} />
            {canDownload && (
              <Tooltip title="Download file">
                <IconButton
                  size="small"
                  color="primary"
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
                  onClick={(e) => {
                    e.stopPropagation();
                    onPauseItem?.(queryId, doc.id);
                  }}
                >
                  {isPaused ? (
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
                {docLabel}
              </Typography>
            </Box>
          }
        />
      </ListItem>
    </Box>
  );
}

// Module-level component — stable reference, receives data via rowProps from react-window.
function Row({ index, style, documents, queryId, onPauseItem, onDeleteItem }) {
  return (
    <DocumentRow
      index={index}
      style={style}
      documents={documents}
      queryId={queryId}
      onPauseItem={onPauseItem}
      onDeleteItem={onDeleteItem}
    />
  );
}

/**
 * Expandable list of documents for a queue item.
 * @param {{
 *   queryId: number,
 *   results: number | null,
 *   searchResults: Array | undefined,
 *   isOpen: boolean,
 *   isLoading: boolean,
 *   onPauseItem: (queryId: number, itemId: number) => void,
 *   onDeleteItem: (queryId: number, itemId: number) => void,
 * }} props
 */
function DocumentList({
  queryId,
  results,
  searchResults,
  isOpen,
  isLoading,
  onPauseItem,
  onDeleteItem,
}) {
  const documents = React.useMemo(
    () => (Array.isArray(searchResults) ? searchResults : []),
    [searchResults]
  );
  const documentCount = searchResults?.length > 0 ? searchResults.length : (results ?? "N/A");
  const height = Math.min(400, documents.length * ITEM_HEIGHT);

  const rowProps = React.useMemo(
    () => ({ documents, queryId, onPauseItem, onDeleteItem }),
    [documents, queryId, onPauseItem, onDeleteItem]
  );

  return (
    <Collapse in={isOpen} timeout={200}>
      <Box sx={{ p: 1 }}>
        <Divider />
        <Box sx={{ px: 1, py: 1 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
            <DescriptionRoundedIcon fontSize="small" sx={{ color: "text.secondary" }} />
            <Typography variant="subtitle2" sx={{ color: "text.secondary", fontWeight: 600 }}>
              Documents ({documentCount})
            </Typography>
          </Box>

          {isLoading ? (
            <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
              <CircularProgress size={24} thickness={3} />
            </Box>
          ) : documents.length === 0 && isOpen ? (
            <Typography variant="caption" sx={{ color: "text.secondary", ml: 4 }}>
              {results === 0
                ? "No documents found for this query."
                : results != null
                  ? "Getting document details..."
                  : "No document details available."}
            </Typography>
          ) : (
            <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1 }}>
              <List
                defaultHeight={height}
                rowCount={documents.length}
                rowHeight={ITEM_HEIGHT}
                rowComponent={Row}
                rowProps={rowProps}
                style={{ width: "100%", overflowY: "hidden" }}
              />
            </Box>
          )}
        </Box>
      </Box>
    </Collapse>
  );
}

export default React.memo(DocumentList);
