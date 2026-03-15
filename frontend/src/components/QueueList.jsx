import React from 'react'
import { Box, Card, CardContent, Chip, Typography, Tooltip, Divider } from '@mui/material'
import ScheduleRoundedIcon from '@mui/icons-material/ScheduleRounded'
import LinkRoundedIcon from '@mui/icons-material/LinkRounded'
import LibraryBooksRoundedIcon from '@mui/icons-material/LibraryBooksRounded'
import InboxRoundedIcon from '@mui/icons-material/InboxRounded'

function formatTimestamp(value) {
  if (!value) return 'N/A'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'N/A' : date.toLocaleString()
}

const STATUS_CONFIG = {
  pending: { label: 'Pending', color: 'default' },
  queued: { label: 'Queued', color: 'default' },
  running: { label: 'Running', color: 'primary' },
  processing: { label: 'Processing', color: 'primary' },
  done: { label: 'Done', color: 'success' },
  completed: { label: 'Completed', color: 'success' },
  failed: { label: 'Failed', color: 'error' },
  error: { label: 'Error', color: 'error' },
}

function StatusChip({ status }) {
  const key = (status ?? '').toLowerCase()
  const config = STATUS_CONFIG[key] ?? { label: status || 'Unknown', color: 'default' }
  return (
    <Chip
      label={config.label}
      color={config.color}
      size="small"
      variant={config.color === 'default' ? 'outlined' : 'filled'}
      sx={{ fontWeight: 600, fontSize: '0.7rem', height: 22, letterSpacing: '0.03em' }}
    />
  )
}

function MetaItem({ icon, label, value, truncate = false }) {
  const content = (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', color: 'text.secondary', flexShrink: 0 }}>{icon}</Box>
      <Typography
        variant="caption"
        sx={{
          color: 'text.secondary',
          fontWeight: 500,
          mr: 0.5,
          flexShrink: 0,
        }}
      >
        {label}
      </Typography>
      <Typography
        variant="caption"
        sx={{
          color: 'text.primary',
          ...(truncate
            ? {
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }
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

function QueueItem({ item, index }) {
  const label = item.pageUrl ?? `Query #${item.id ?? index + 1}`
  const created = formatTimestamp(item.createdAt)
  const results = item.results ?? 'N/A'

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
      <CardContent sx={{ p: '12px 16px !important' }}>
        {/* Top row: URL label + status chip */}
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, mb: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flex: 1, minWidth: 0 }}>
            <LinkRoundedIcon sx={{ fontSize: 14, color: 'text.secondary', flexShrink: 0, mt: '1px' }} />
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
          <StatusChip status={item.status} />
        </Box>

        <Divider sx={{ mb: 1, borderColor: 'divider' }} />

        {/* Bottom row: meta info */}
        <Box
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: { xs: 1, sm: 2.5 },
            alignItems: 'center',
          }}
        >
          <MetaItem icon={<LibraryBooksRoundedIcon sx={{ fontSize: 13 }} />} label="Results:" value={results} />
          <MetaItem icon={<ScheduleRoundedIcon sx={{ fontSize: 13 }} />} label="Created:" value={created} />
        </Box>
      </CardContent>
    </Card>
  )
}

export default function QueueList({ queue }) {
  if (!queue || queue.length === 0) {
    return (
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1.5,
          py: 8,
          color: 'text.secondary',
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
    )
  }

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          mb: 1.5,
        }}
      >
        <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.secondary', letterSpacing: '0.04em' }}>
          QUEUE
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {queue.length} {queue.length === 1 ? 'item' : 'items'}
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {queue.map((item, index) => (
          <QueueItem key={item.id ?? item.pageUrl ?? `queue-item-${index}`} item={item} index={index} />
        ))}
      </Box>
    </Box>
  )
}
