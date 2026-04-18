import React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Card,
  CardContent,
  CircularProgress,
  Divider,
  Drawer,
  IconButton,
  LinearProgress,
  Tooltip,
  Typography,
} from "@mui/material";
import { styled } from "@mui/material/styles";
import ScheduleRoundedIcon from "@mui/icons-material/ScheduleRounded";
import LinkRoundedIcon from "@mui/icons-material/LinkRounded";
import LibraryBooksRoundedIcon from "@mui/icons-material/LibraryBooksRounded";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import PauseRoundedIcon from "@mui/icons-material/PauseRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import { RETRYABLE_STATUSES } from "@shared/constants.js";
import { fetchQueueItem, downloadQuery } from "../api/queue.api.js";
import StatusChip from "./StatusChip";
import DocumentList from "./DocumentList";

function formatTimestamp(value) {
  if (!value) return "N/A";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "N/A" : date.toLocaleString();
}

const ACTIVE_STATUSES = ["pending", "fetching_metadata", "fetching_results", "downloading"];

function extractQueryLabel(url) {
  try {
    const u = new URL(url);
    const queryParams = u.searchParams.getAll("query");
    if (queryParams.length > 0) {
      const OPERATORS = new Set(["AND", "OR", "NOT"]);
      const terms = queryParams
        .map((qp) => {
          const parts = qp.split(",");
          // Format: fieldCode,matchType,value[,operator]
          // Strip trailing boolean operator if present
          const valueParts = parts.slice(2);
          if (valueParts.length > 0 && OPERATORS.has(valueParts[valueParts.length - 1])) {
            valueParts.pop();
          }
          return decodeURIComponent(valueParts.join(",").replace(/\+/g, " ")).trim();
        })
        .filter(Boolean);
      if (terms.length > 0) return terms.join(" · ");
    }
    return u.hostname;
  } catch {
    return url;
  }
}

function MetaItem({ icon, label, value, truncate = false }) {
  const content = (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
      <Box sx={{ display: "flex", alignItems: "center", color: "text.secondary", flexShrink: 0 }}>
        {icon}
      </Box>
      <Typography
        variant="caption"
        sx={{ color: "text.secondary", fontWeight: 500, mr: 0.5, flexShrink: 0 }}
      >
        {label}
      </Typography>
      <Typography
        variant="caption"
        sx={{
          color: "text.primary",
          ...(truncate
            ? { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }
            : {}),
        }}
      >
        {value}
      </Typography>
    </Box>
  );

  return truncate ? (
    <Tooltip title={value} placement="bottom-start">
      <Box sx={{ minWidth: 0, flex: 1 }}>{content}</Box>
    </Tooltip>
  ) : (
    <Box>{content}</Box>
  );
}

const ExpandButton = styled(IconButton, {
  shouldForwardProp: (prop) => prop !== "expand",
})(({ theme, expand }) => ({
  transform: expand ? "rotate(180deg)" : "rotate(0deg)",
  transition: theme.transitions.create("transform", {
    duration: theme.transitions.duration.shortest,
  }),
  color: theme.palette.text.secondary,
}));

/**
 * @param {{
 *   item: import('../../../shared/types.js').Query & { isPending?: boolean, pendingError?: string },
 *   index: number,
 *   isDeleting: boolean,
 *   isRetrying: boolean,
 *   isPausing: boolean,
 *   pausingItemId: number | null,
 *   onRequestDelete: (item: object) => void,
 *   onRetry: (item: object) => void,
 *   onPause: (id: number) => void,
 *   onPauseItem: (queryId: number, itemId: number) => void,
 *   onDeleteItem: (queryId: number, itemId: number) => void,
 * }} props
 */
export default React.memo(function QueueItem({
  item,
  index,
  isDeleting,
  isRetrying,
  isPausing,
  pausingItemId,
  onRequestDelete,
  onRetry,
  onPause,
  onPauseItem,
  onDeleteItem,
}) {
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [copiedUrl, setCopiedUrl] = React.useState(false);
  const [isZipping, setIsZipping] = React.useState(false);
  const [downloadError, setDownloadError] = React.useState(null);

  // Derive status early — needed by useQuery's enabled option below.
  const status = (item.status ?? "").toLowerCase();

  // Eagerly fetch detail for active items (data changes frequently) so it's ready when the
  // Drawer opens. For terminal-state items, fetch on-demand when the Drawer is opened (P1).
  // Background polling activates only while the Drawer is open to keep document statuses fresh.
  const { data: detail, isLoading: isDetailLoading } = useQuery({
    queryKey: ["queue-item", item.id],
    queryFn: () => fetchQueueItem(item.id),
    enabled: (ACTIVE_STATUSES.includes(status) || drawerOpen) && !!item.id && !item.isPending,
    refetchInterval: drawerOpen ? 2000 : false,
    staleTime: 1000,
  });

  // item always has the freshest status/downloaded/etc from the 1s poll.
  // searchResults come from the per-card detail query (lazy-loaded on expand).

  const label = item.pageUrl ? extractQueryLabel(item.pageUrl) : `Query #${item.id ?? index + 1}`;
  const created = formatTimestamp(item.createdAt);
  const searchResults = detail?.searchResults;
  const resultsCount = searchResults?.length > 0 ? searchResults.length : (item.results ?? "N/A");

  const isPaused = status === "paused";
  const canPause = ["pending", "downloading"].includes(status) || isPaused;
  const canRetry = RETRYABLE_STATUSES.includes(status);
  const isActing = isDeleting || isRetrying || isPausing || item.isPending;

  const isFailed = status === "search_failed" || status === "download_blocked";
  const lastAttempt = item.lastAttempt ? formatTimestamp(item.lastAttempt) : null;
  const isDownloading = status === "downloading";
  const downloadedCount = item.downloaded ?? 0;
  const totalCount = item.results ?? 0;
  const progressPercent = totalCount > 0 ? Math.min(100, (downloadedCount / totalCount) * 100) : 0;

  const resultCounts = React.useMemo(() => {
    const counts = { completed: 0, download_blocked: 0, paused: 0 };
    searchResults?.forEach((r) => {
      if (r.status === "completed") counts.completed++;
      else if (r.status === "download_blocked") counts.download_blocked++;
      else if (r.status === "paused") counts.paused++;
    });
    return counts;
  }, [searchResults]);

  const handleDelete = (e) => {
    e.stopPropagation();
    if (!item?.id) return;
    onRequestDelete?.(item, label);
  };

  const handleRetry = (e) => {
    e.stopPropagation();
    if (!item?.id) return;
    onRetry?.(item);
  };

  const handlePause = (e) => {
    e.stopPropagation();
    if (!item?.id) return;
    onPause?.(item.id);
  };

  const handleCopyUrl = (e) => {
    e.stopPropagation();
    if (!item?.pageUrl) return;
    navigator.clipboard.writeText(item.pageUrl).catch(() => {});
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 1500);
  };

  const handleDownload = async (e) => {
    e.stopPropagation();
    if (!item?.id || isZipping) return;
    setIsZipping(true);
    setDownloadError(null);
    try {
      const blob = await downloadQuery(item.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${label.replace(/[/\\:*?"<>|]/g, "_")}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      let message = "Failed to prepare download";
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
      setIsZipping(false);
    }
  };

  return (
    <Card
      variant="outlined"
      sx={{
        borderColor: "divider",
        transition: "border-color 0.15s ease, box-shadow 0.15s ease",
        "&:hover": {
          borderColor: "primary.main",
          boxShadow: (theme) => `0 0 0 1px ${theme.palette.primary.main}44`,
        },
      }}
    >
      <CardContent
        onClick={() => setDrawerOpen((s) => !s)}
        sx={{
          p: "12px 16px !important",
          cursor: "pointer",
          opacity: status === "pending" ? 0.7 : 1,
          backgroundColor: status === "search_failed" ? "rgba(211, 47, 47, 0.08)" : "transparent",
        }}
      >
        {/* Top row: URL label + status chip + action buttons + expand */}
        <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1.5, mb: 1 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, flex: 1, minWidth: 0 }}>
            {ACTIVE_STATUSES.includes(status) && (
              <CircularProgress size={14} thickness={4} sx={{ flexShrink: 0 }} />
            )}
            {!ACTIVE_STATUSES.includes(status) && (
              <LinkRoundedIcon
                sx={{ fontSize: 14, color: "text.secondary", flexShrink: 0, mt: "1px" }}
              />
            )}
            <Tooltip title={label} placement="top-start">
              <Typography
                variant="body2"
                sx={{
                  fontWeight: 600,
                  color: "text.primary",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: "0.82rem",
                }}
              >
                {label}
              </Typography>
            </Tooltip>
            {item.pageUrl && (
              <Tooltip title={copiedUrl ? "Copied!" : "Copy URL"}>
                <IconButton
                  size="small"
                  sx={{ p: 0.25, flexShrink: 0, color: "text.secondary" }}
                  onClick={handleCopyUrl}
                >
                  <ContentCopyRoundedIcon sx={{ fontSize: 12 }} />
                </IconButton>
              </Tooltip>
            )}
          </Box>

          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <StatusChip status={item.status} />

            {canPause && (
              <Tooltip title={isPaused ? "Resume" : "Pause"}>
                <IconButton
                  size="small"
                  aria-label={isPaused ? "Resume item" : "Pause item"}
                  color={isPaused ? "warning" : "default"}
                  onClick={handlePause}
                  disabled={isActing}
                >
                  {isPaused ? (
                    <PlayArrowRoundedIcon sx={{ fontSize: 18 }} />
                  ) : (
                    <PauseRoundedIcon sx={{ fontSize: 18 }} />
                  )}
                </IconButton>
              </Tooltip>
            )}

            {canRetry && (
              <Tooltip title="Retry">
                <IconButton
                  size="small"
                  aria-label="Retry item"
                  color="primary"
                  onClick={handleRetry}
                  disabled={isActing}
                >
                  <ReplayRoundedIcon sx={{ fontSize: 18 }} />
                </IconButton>
              </Tooltip>
            )}

            <Tooltip title="Delete">
              <IconButton
                size="small"
                aria-label="Delete item"
                color="error"
                onClick={handleDelete}
                disabled={isActing}
              >
                <DeleteRoundedIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>

            {downloadedCount > 0 && (
              <Tooltip
                title={
                  isZipping
                    ? "Preparing ZIP…"
                    : status === "downloading"
                      ? "Download in progress — pause or wait for completion"
                      : isPaused && totalCount > 0
                        ? `Download partial files (${downloadedCount} of ${totalCount})`
                        : "Download files"
                }
              >
                <span>
                  <IconButton
                    size="small"
                    aria-label="Download files"
                    color="primary"
                    onClick={handleDownload}
                    disabled={isActing || isZipping || status === "downloading"}
                  >
                    {isZipping ? (
                      <CircularProgress size={18} />
                    ) : (
                      <DownloadRoundedIcon sx={{ fontSize: 18 }} />
                    )}
                  </IconButton>
                </span>
              </Tooltip>
            )}

            <ExpandButton
              aria-expanded={drawerOpen}
              aria-label={drawerOpen ? "Close documents" : "View documents"}
              expand={drawerOpen}
              size="small"
              onClick={(e) => {
                e.stopPropagation();
                setDrawerOpen((s) => !s);
              }}
            >
              <ExpandMoreIcon sx={{ fontSize: 18 }} />
            </ExpandButton>
          </Box>
        </Box>

        <Divider sx={{ mb: 1, borderColor: "divider" }} />

        {status === "search_failed" && (
          <Alert severity="error" sx={{ mb: 1, fontSize: "0.85rem" }}>
            {item.pendingError || "This job failed. You can retry it."}
          </Alert>
        )}

        {status === "download_blocked" && (
          <Alert severity="warning" sx={{ mb: 1, fontSize: "0.85rem" }}>
            Some downloads were blocked by the archive. Retry to attempt missing files.
          </Alert>
        )}

        {downloadError && (
          <Alert
            severity="error"
            sx={{ mb: 1, fontSize: "0.85rem" }}
            onClose={(e) => {
              e.stopPropagation();
              setDownloadError(null);
            }}
          >
            {downloadError}
          </Alert>
        )}

        <Box
          sx={{ display: "flex", flexWrap: "wrap", gap: { xs: 1, sm: 2.5 }, alignItems: "center" }}
        >
          <MetaItem
            icon={<LibraryBooksRoundedIcon sx={{ fontSize: 13 }} />}
            label="Results:"
            value={resultsCount}
          />
          <MetaItem
            icon={<ScheduleRoundedIcon sx={{ fontSize: 13 }} />}
            label="Created:"
            value={created}
          />
          {isFailed && lastAttempt && (
            <MetaItem
              icon={<ScheduleRoundedIcon sx={{ fontSize: 13 }} />}
              label="Last attempt:"
              value={lastAttempt}
            />
          )}
        </Box>

        {isDownloading && totalCount > 0 && (
          <Box sx={{ mt: 1 }}>
            <Box sx={{ display: "flex", justifyContent: "space-between", mb: 0.5 }}>
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                Downloading
              </Typography>
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                {downloadedCount} / {totalCount} ({progressPercent.toFixed(0)}%)
              </Typography>
            </Box>
            <LinearProgress
              variant="determinate"
              value={progressPercent}
              sx={{ borderRadius: 1, height: 6 }}
            />
          </Box>
        )}

        {searchResults?.length > 0 &&
          (resultCounts.completed > 0 ||
            resultCounts.download_blocked > 0 ||
            resultCounts.paused > 0) && (
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1.5, mt: 0.75 }}>
              {resultCounts.completed > 0 && (
                <Typography variant="caption" sx={{ color: "success.main" }}>
                  ✓ {resultCounts.completed} done
                </Typography>
              )}
              {resultCounts.download_blocked > 0 && (
                <Typography variant="caption" sx={{ color: "error.main" }}>
                  ✗ {resultCounts.download_blocked} blocked
                </Typography>
              )}
              {resultCounts.paused > 0 && (
                <Typography variant="caption" sx={{ color: "warning.main" }}>
                  ⏸ {resultCounts.paused} paused
                </Typography>
              )}
            </Box>
          )}
      </CardContent>

      <Drawer
        anchor="right"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        PaperProps={{
          sx: { width: { xs: "100vw", sm: 520 }, display: "flex", flexDirection: "column" },
        }}
      >
        <Box
          sx={{
            px: 2,
            pt: 1.5,
            pb: 1,
            borderBottom: "1px solid",
            borderColor: "divider",
            flexShrink: 0,
          }}
        >
          {/* Row 1: icon + label + copy + close */}
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, mb: 0.75 }}>
            {ACTIVE_STATUSES.includes(status) ? (
              <CircularProgress
                size={13}
                thickness={4}
                sx={{ flexShrink: 0, color: "text.secondary" }}
              />
            ) : (
              <LinkRoundedIcon sx={{ fontSize: 13, color: "text.secondary", flexShrink: 0 }} />
            )}
            <Typography
              variant="subtitle1"
              sx={{
                flex: 1,
                fontWeight: 600,
                fontSize: "0.9rem",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {label}
            </Typography>
            {item.pageUrl && (
              <Tooltip title={copiedUrl ? "Copied!" : "Copy URL"}>
                <IconButton
                  size="small"
                  sx={{ p: 0.25, flexShrink: 0, color: "text.secondary" }}
                  onClick={handleCopyUrl}
                >
                  <ContentCopyRoundedIcon sx={{ fontSize: 12 }} />
                </IconButton>
              </Tooltip>
            )}
            <IconButton
              size="small"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close documents"
            >
              <CloseRoundedIcon fontSize="small" />
            </IconButton>
          </Box>

          {/* Row 2: status chip + action buttons */}
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            <StatusChip status={item.status} />

            {canPause && (
              <Tooltip title={isPaused ? "Resume" : "Pause"}>
                <IconButton
                  size="small"
                  aria-label={isPaused ? "Resume item" : "Pause item"}
                  color={isPaused ? "warning" : "default"}
                  onClick={handlePause}
                  disabled={isActing}
                >
                  {isPaused ? (
                    <PlayArrowRoundedIcon sx={{ fontSize: 18 }} />
                  ) : (
                    <PauseRoundedIcon sx={{ fontSize: 18 }} />
                  )}
                </IconButton>
              </Tooltip>
            )}

            {canRetry && (
              <Tooltip title="Retry">
                <IconButton
                  size="small"
                  aria-label="Retry item"
                  color="primary"
                  onClick={handleRetry}
                  disabled={isActing}
                >
                  <ReplayRoundedIcon sx={{ fontSize: 18 }} />
                </IconButton>
              </Tooltip>
            )}

            <Tooltip title="Delete">
              <IconButton
                size="small"
                aria-label="Delete item"
                color="error"
                onClick={handleDelete}
                disabled={isActing}
              >
                <DeleteRoundedIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>

            {downloadedCount > 0 && (
              <Tooltip
                title={
                  downloadError
                    ? `Download error: ${downloadError}`
                    : isZipping
                      ? "Preparing ZIP…"
                      : isDownloading
                        ? "Download in progress — pause or wait for completion"
                        : isPaused && totalCount > 0
                          ? `Download partial files (${downloadedCount} of ${totalCount})`
                          : "Download files"
                }
              >
                <span>
                  <IconButton
                    size="small"
                    aria-label="Download files"
                    color={downloadError ? "error" : "primary"}
                    onClick={handleDownload}
                    disabled={isActing || isZipping || isDownloading}
                  >
                    {isZipping ? (
                      <CircularProgress size={18} />
                    ) : (
                      <DownloadRoundedIcon sx={{ fontSize: 18 }} />
                    )}
                  </IconButton>
                </span>
              </Tooltip>
            )}
          </Box>
        </Box>
        <Box sx={{ flex: 1, overflow: "hidden" }}>
          <DocumentList
            queryId={item.id}
            results={item.results}
            searchResults={searchResults}
            isLoading={isDetailLoading && !detail}
            onPauseItem={onPauseItem}
            onDeleteItem={onDeleteItem}
            pausingItemId={pausingItemId}
          />
        </Box>
      </Drawer>
    </Card>
  );
});
