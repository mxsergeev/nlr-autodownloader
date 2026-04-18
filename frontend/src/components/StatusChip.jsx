import { Chip } from "@mui/material";

const STATUS_CONFIG = {
  pending: { label: "Pending", color: "default" },
  downloading: { label: "Downloading", color: "primary" },
  completed: { label: "Completed", color: "success" },
  download_blocked: { label: "Download Blocked", color: "error" },
  search_failed: { label: "Search Failed", color: "error" },
  paused: { label: "Paused", color: "warning" },
  fetching_metadata: { label: "Fetching URL details", color: "info" },
  fetching_results: { label: "Fetching document list", color: "info" },
};

/**
 * @param {{ status: string | null | undefined }} props
 */
export default function StatusChip({ status }) {
  const key = (status ?? "").toLowerCase();
  const config = STATUS_CONFIG[key] ?? { label: status || "Unknown", color: "default" };

  return (
    <Chip
      label={config.label}
      color={config.color}
      size="small"
      variant={config.color === "default" ? "outlined" : "filled"}
      sx={{ fontWeight: 600, fontSize: "0.7rem", height: 22, letterSpacing: "0.03em" }}
    />
  );
}
