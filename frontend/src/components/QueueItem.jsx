import React from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Alert,
  Box,
  Card,
  CardContent,
  CircularProgress,
  Divider,
  IconButton,
  LinearProgress,
  Tooltip,
  Typography,
} from '@mui/material'
import { styled } from '@mui/material/styles'
import ScheduleRoundedIcon from '@mui/icons-material/ScheduleRounded'
import LinkRoundedIcon from '@mui/icons-material/LinkRounded'
import LibraryBooksRoundedIcon from '@mui/icons-material/LibraryBooksRounded'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import ReplayRoundedIcon from '@mui/icons-material/ReplayRounded'
import PauseRoundedIcon from '@mui/icons-material/PauseRounded'
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded'
import { RETRYABLE_STATUSES } from '@shared/constants.js'
import { fetchQueueItem } from '../api/queue.api.js'
import StatusChip from './StatusChip'
import DocumentList from './DocumentList'

function formatTimestamp(value) {
  if (!value) return 'N/A'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'N/A' : date.toLocaleString()
}

const ACTIVE_STATUSES = ['pending', 'fetching_metadata', 'fetching_results', 'downloading']

function extractQueryLabel(url) {
  try {
    const u = new URL(url)
    const queryParams = u.searchParams.getAll('query')
    if (queryParams.length > 0) {
      const OPERATORS = new Set(['AND', 'OR', 'NOT'])
      const terms = queryParams
        .map((qp) => {
          const parts = qp.split(',')
          // Format: fieldCode,matchType,value[,operator]
          // Strip trailing boolean operator if present
          const valueParts = parts.slice(2)
          if (valueParts.length > 0 && OPERATORS.has(valueParts[valueParts.length - 1])) {
            valueParts.pop()
          }
          return decodeURIComponent(valueParts.join(',').replace(/\+/g, ' ')).trim()
        })
        .filter(Boolean)
      if (terms.length > 0) return terms.join(' · ')
    }
    return u.hostname
  } catch {
    return url
  }
}

function MetaItem({ icon, label, value, truncate = false }) {
  const content = (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', color: 'text.secondary', flexShrink: 0 }}>{icon}</Box>
      <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 500, mr: 0.5, flexShrink: 0 }}>
        {label}
      </Typography>
      <Typography
        variant="caption"
        sx={{
          color: 'text.primary',
          ...(truncate
            ? { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }
            : {}),
        }}
      >
        {value}
      </Typography>
    </Box>
  )

  return truncate ? (
    <Tooltip title={value} placement="bottom-start">
      <Box sx={{ minWidth: 0, flex: 1 }}>{content}</Box>
    </Tooltip>
  ) : (
    <Box>{content}</Box>
  )
}

const ExpandButton = styled(IconButton, {
  shouldForwardProp: (prop) => prop !== 'expand',
})(({ theme, expand }) => ({
  transform: expand ? 'rotate(180deg)' : 'rotate(0deg)',
  transition: theme.transitions.create('transform', {
    duration: theme.transitions.duration.shortest,
  }),
  color: theme.palette.text.secondary,
}))

/**
 * @param {{
 *   item: import('../../../shared/types.js').Query & { isPending?: boolean, pendingError?: string },
 *   index: number,
 *   isDeleting: boolean,
 *   isRetrying: boolean,
 *   isPausing: boolean,
 *   onRequestDelete: (item: object) => void,
 *   onRetry: (item: object) => void,
 *   onPause: (id: number) => void,
 *   onPauseItem: (queryId: number, itemId: number) => void,
 *   onDeleteItem: (queryId: number, itemId: number) => void,
 * }} props
 */
export default React.memo(function QueueItem({ item, index, isDeleting, isRetrying, isPausing, onRequestDelete, onRetry, onPause, onPauseItem, onDeleteItem }) {
  const [expanded, setExpanded] = React.useState(false)

  // Fetch full card data (with searchResults) lazily when expanded.
  // Main poll returns slim cards without searchResults to keep 1s polling fast.
  const { data: detail } = useQuery({
    queryKey: ['queue-item', item.id],
    queryFn: () => fetchQueueItem(item.id),
    enabled: expanded && !!item.id && !item.isPending,
    refetchInterval: expanded ? 2000 : false,
    staleTime: 1000,
  })

  // Merge slim item from poll with detailed data fetched on expand
  const fullItem = detail ?? item

  const label = item.pageUrl ? extractQueryLabel(item.pageUrl) : `Query #${item.id ?? index + 1}`
  const created = formatTimestamp(item.createdAt)
  const resultsCount = fullItem.searchResults?.length > 0 ? fullItem.searchResults.length : (item.results ?? 'N/A')
  const status = (item.status ?? '').toLowerCase()

  const isPaused = status === 'paused'
  const canPause = ['pending', 'downloading'].includes(status) || isPaused
  const canRetry = RETRYABLE_STATUSES.includes(status)
  const isActing = isDeleting || isRetrying || isPausing || item.isPending

  const isFailed = status === 'search_failed' || status === 'download_blocked'
  const lastAttempt = item.lastAttempt ? formatTimestamp(item.lastAttempt) : null
  const isDownloading = status === 'downloading'
  const downloadedCount = item.downloaded ?? 0
  const totalCount = item.results ?? 0
  const progressPercent = totalCount > 0 ? Math.min(100, (downloadedCount / totalCount) * 100) : 0

  const resultCounts = React.useMemo(() => {
    const counts = { completed: 0, download_blocked: 0, paused: 0 }
    fullItem.searchResults?.forEach((r) => {
      if (r.status === 'completed') counts.completed++
      else if (r.status === 'download_blocked') counts.download_blocked++
      else if (r.status === 'paused') counts.paused++
    })
    return counts
  }, [fullItem.searchResults])

  const handleDelete = (e) => {
    e.stopPropagation()
    if (!item?.id) return
    onRequestDelete?.(item)
  }

  const handleRetry = (e) => {
    e.stopPropagation()
    if (!item?.id) return
    onRetry?.(item)
  }

  const handlePause = (e) => {
    e.stopPropagation()
    if (!item?.id) return
    onPause?.(item.id)
  }

  return (
    <Card
      variant="outlined"
      sx={{
        borderColor: 'divider',
        transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
        '&:hover': {
          borderColor: 'primary.main',
          boxShadow: (theme) => `0 0 0 1px ${theme.palette.primary.main}44`,
        },
      }}
    >
      <CardContent
        onClick={() => setExpanded((s) => !s)}
        sx={{
          p: '12px 16px !important',
          cursor: 'pointer',
          opacity: status === 'pending' ? 0.7 : 1,
          backgroundColor: status === 'search_failed' ? 'rgba(211, 47, 47, 0.08)' : 'transparent',
        }}
      >
        {/* Top row: URL label + status chip + action buttons + expand */}
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, mb: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flex: 1, minWidth: 0 }}>
            {ACTIVE_STATUSES.includes(status) && <CircularProgress size={14} thickness={4} sx={{ flexShrink: 0 }} />}
            {!ACTIVE_STATUSES.includes(status) && (
              <LinkRoundedIcon sx={{ fontSize: 14, color: 'text.secondary', flexShrink: 0, mt: '1px' }} />
            )}
            <Tooltip title={label} placement="top-start">
              <Typography
                variant="body2"
                sx={{
                  fontWeight: 600,
                  color: 'text.primary',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: '0.82rem',
                }}
              >
                {label}
              </Typography>
            </Tooltip>
          </Box>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <StatusChip status={item.status} />

            {canPause && (
              <Tooltip title={isPaused ? 'Resume' : 'Pause'}>
                <IconButton
                  size="small"
                  aria-label={isPaused ? 'Resume item' : 'Pause item'}
                  color={isPaused ? 'warning' : 'default'}
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

            <ExpandButton
              aria-expanded={expanded}
              aria-label={expanded ? 'Collapse item' : 'Expand item'}
              expand={expanded ? 1 : 0}
              size="small"
              onClick={(e) => {
                e.stopPropagation()
                setExpanded((s) => !s)
              }}
            >
              <ExpandMoreIcon sx={{ fontSize: 18 }} />
            </ExpandButton>
          </Box>
        </Box>

        <Divider sx={{ mb: 1, borderColor: 'divider' }} />

        {status === 'search_failed' && (
          <Alert severity="error" sx={{ mb: 1, fontSize: '0.85rem' }}>
            {item.pendingError || 'This job failed. You can retry it.'}
          </Alert>
        )}

        {status === 'download_blocked' && (
          <Alert severity="warning" sx={{ mb: 1, fontSize: '0.85rem' }}>
            Some downloads were blocked by the archive. Retry to attempt missing files.
          </Alert>
        )}

        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: { xs: 1, sm: 2.5 }, alignItems: 'center' }}>
          <MetaItem icon={<LibraryBooksRoundedIcon sx={{ fontSize: 13 }} />} label="Results:" value={resultsCount} />
          <MetaItem icon={<ScheduleRoundedIcon sx={{ fontSize: 13 }} />} label="Created:" value={created} />
          {isFailed && lastAttempt && (
            <MetaItem icon={<ScheduleRoundedIcon sx={{ fontSize: 13 }} />} label="Last attempt:" value={lastAttempt} />
          )}
        </Box>

        {isDownloading && totalCount > 0 && (
          <Box sx={{ mt: 1 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                Downloading
              </Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {downloadedCount} / {totalCount} ({progressPercent.toFixed(0)}%)
              </Typography>
            </Box>
            <LinearProgress variant="determinate" value={progressPercent} sx={{ borderRadius: 1, height: 6 }} />
          </Box>
        )}

        {fullItem.searchResults?.length > 0 &&
          (resultCounts.completed > 0 || resultCounts.download_blocked > 0 || resultCounts.paused > 0) && (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, mt: 0.75 }}>
              {resultCounts.completed > 0 && (
                <Typography variant="caption" sx={{ color: 'success.main' }}>
                  ✓ {resultCounts.completed} done
                </Typography>
              )}
              {resultCounts.download_blocked > 0 && (
                <Typography variant="caption" sx={{ color: 'error.main' }}>
                  ✗ {resultCounts.download_blocked} blocked
                </Typography>
              )}
              {resultCounts.paused > 0 && (
                <Typography variant="caption" sx={{ color: 'warning.main' }}>
                  ⏸ {resultCounts.paused} paused
                </Typography>
              )}
            </Box>
          )}
      </CardContent>

      <DocumentList
        item={fullItem}
        isOpen={expanded}
        onPauseItem={onPauseItem}
        onDeleteItem={onDeleteItem}
      />
    </Card>
  )
})
