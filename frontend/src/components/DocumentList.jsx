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
import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import PauseRoundedIcon from "@mui/icons-material/PauseRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import StatusChip from "./StatusChip";

const ITEM_HEIGHT = 60;

function DocumentRow({ index, style, documents, queryId, onPauseItem, onDeleteItem }) {
  const doc = documents[index];
  const isPaused = doc.status === "paused";
  const canPause = ["pending", "paused"].includes(doc.status);

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
                  onDeleteItem?.(queryId, doc.id);
                }}
              >
                <DeleteRoundedIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          </Box>
        }
      >
        <ListItemText
          primary={
            <Typography
              variant="body2"
              sx={{
                fontWeight: 500,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: "calc(100% - 180px)",
                fontSize: "0.85rem",
              }}
            >
              {doc.fileName ?? doc.title ?? doc.href ?? "Untitled"}
            </Typography>
          }
          secondary={
            doc.href ? (
              <Tooltip title={doc.href}>
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: "100%",
                    fontSize: "0.75rem",
                  }}
                >
                  {doc.href}
                </Typography>
              </Tooltip>
            ) : null
          }
        />
      </ListItem>
    </Box>
  );
}

/**
 * Expandable list of documents for a queue item.
 * @param {{
 *   isOpen: boolean,
 *   onPauseItem: (queryId: number, itemId: number) => void,
 *   onDeleteItem: (queryId: number, itemId: number) => void,
 * }} props
 */
export default function DocumentList({ item, isOpen, isLoading, onPauseItem, onDeleteItem }) {
  const documents = Array.isArray(item.searchResults) ? item.searchResults : [];
  const documentCount =
    item.searchResults?.length > 0 ? item.searchResults.length : (item.results ?? "N/A");
  const height = Math.min(400, documents.length * ITEM_HEIGHT);

  const Row = React.useCallback(
    ({ index, style }) => (
      <DocumentRow
        index={index}
        style={style}
        documents={documents}
        queryId={item.id}
        onPauseItem={onPauseItem}
        onDeleteItem={onDeleteItem}
      />
    ),
    [documents, item.id, onPauseItem, onDeleteItem]
  );

  return (
    <Collapse in={isOpen} timeout={200} unmountOnExit>
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
          ) : documents.length === 0 ? (
            <Typography variant="caption" sx={{ color: "text.secondary", ml: 4 }}>
              {item.results === 0
                ? "No documents found for this query."
                : item.results > 0 && documents.length === 0
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
                rowProps={{}}
                style={{ width: "100%" }}
              />
            </Box>
          )}
        </Box>
      </Box>
    </Collapse>
  );
}
