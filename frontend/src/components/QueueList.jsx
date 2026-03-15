import React from 'react'
import axios from 'axios'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Box,
  Card,
  CardContent,
  Chip,
  Typography,
  Tooltip,
  Divider,
  List,
  ListItem,
  ListItemText,
  IconButton,
  Collapse,
  Button,
  Snackbar,
  Alert,
} from '@mui/material'
import ConfirmDialog from './ConfirmDialog'
import ScheduleRoundedIcon from '@mui/icons-material/ScheduleRounded'
import LinkRoundedIcon from '@mui/icons-material/LinkRounded'
import LibraryBooksRoundedIcon from '@mui/icons-material/LibraryBooksRounded'
import InboxRoundedIcon from '@mui/icons-material/InboxRounded'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import DescriptionRoundedIcon from '@mui/icons-material/DescriptionRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import { styled } from '@mui/material/styles'

function formatTimestamp(value) {
  if (!value) return 'N/A'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'N/A' : date.toLocaleString()
}

const STATUS_CONFIG = {
  pending: { label: 'Pending', color: 'default' },
  downloading: { label: 'Downloading', color: 'primary' },
  completed: { label: 'Completed', color: 'success' },
  download_blocked: { label: 'Download Blocked', color: 'error' },
  search_failed: { label: 'Search Failed', color: 'error' },
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

// Styled expand button that rotates when expanded
const ExpandButton = styled(IconButton, {
  shouldForwardProp: (prop) => prop !== 'expand',
})(({ theme, expand }) => ({
  transform: expand ? 'rotate(180deg)' : 'rotate(0deg)',
  transition: theme.transitions.create('transform', {
    duration: theme.transitions.duration.shortest,
  }),
  color: theme.palette.text.secondary,
}))

function QueueItem({ item, index, isLoading, onRequestDelete }) {
  const [expanded, setExpanded] = React.useState(false)

  const label = item.pageUrl ?? `Query #${item.id ?? index + 1}`
  const created = formatTimestamp(item.createdAt)
  const resultsCount = Array.isArray(item.searchResults) ? item.searchResults.length : (item.results ?? 'N/A')

  const toggle = (ev) => {
    // Prevent toggling when clicking on interactive children in the future
    // but allow single-click expanding the item
    setExpanded((s) => !s)
  }

  const handleDelete = (e) => {
    e.stopPropagation()
    if (!item?.id) return
    onRequestDelete && onRequestDelete(item)
  }

  const searchResults = Array.isArray(item.searchResults) ? item.searchResults : []

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
        onClick={toggle}
        sx={{
          p: '12px 16px !important',
          cursor: 'pointer',
        }}
      >
        {/* Top row: URL label + status chip + expand button */}
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

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <StatusChip status={item.status} />
            <Tooltip title="Delete">
              <IconButton
                size="small"
                aria-label="Delete item"
                color="error"
                onClick={(e) => {
                  handleDelete(e)
                }}
                disabled={isLoading}
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
                // stop propagation so the CardContent's onClick doesn't toggle twice
                e.stopPropagation()
                setExpanded((s) => !s)
              }}
            >
              <ExpandMoreIcon sx={{ fontSize: 18 }} />
            </ExpandButton>
          </Box>
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
          <MetaItem icon={<LibraryBooksRoundedIcon sx={{ fontSize: 13 }} />} label="Results:" value={resultsCount} />
          <MetaItem icon={<ScheduleRoundedIcon sx={{ fontSize: 13 }} />} label="Created:" value={created} />
        </Box>
      </CardContent>

      {/* Expandable area: list of documents */}
      <Collapse in={expanded} timeout="auto" unmountOnExit>
        <Box sx={{ p: 1 }}>
          <Divider />
          <Box sx={{ px: 1, py: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <DescriptionRoundedIcon fontSize="small" sx={{ color: 'text.secondary' }} />
              <Typography variant="subtitle2" sx={{ color: 'text.secondary', fontWeight: 600 }}>
                Documents ({searchResults.length})
              </Typography>
            </Box>

            {searchResults.length === 0 ? (
              <Typography variant="caption" sx={{ color: 'text.secondary', ml: 4 }}>
                No documents found for this query.
              </Typography>
            ) : (
              <List dense disablePadding>
                {searchResults.map((doc, i) => (
                  <React.Fragment key={doc.id ?? doc.href ?? `${i}`}>
                    <ListItem
                      sx={{
                        px: 1,
                        py: 0.5,
                        alignItems: 'center',
                      }}
                      secondaryAction={
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <StatusChip status={doc.status} />
                        </Box>
                      }
                    >
                      <ListItemText
                        primary={
                          <Typography
                            variant="body2"
                            sx={{
                              fontWeight: 500,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              maxWidth: 'calc(100% - 120px)',
                            }}
                          >
                            {doc.fileName ?? doc.title ?? doc.href ?? 'Untitled'}
                          </Typography>
                        }
                        secondary={
                          doc.href ? (
                            <Tooltip title={doc.href}>
                              <Typography
                                variant="caption"
                                sx={{
                                  color: 'text.secondary',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                  maxWidth: '100%',
                                }}
                              >
                                {doc.href}
                              </Typography>
                            </Tooltip>
                          ) : null
                        }
                      />
                    </ListItem>
                    {i < searchResults.length - 1 && <Divider component="li" sx={{ my: 0.5 }} />}
                  </React.Fragment>
                ))}
              </List>
            )}
          </Box>
        </Box>
      </Collapse>
    </Card>
  )
}

export default function QueueList({ queue }) {
  const qc = useQueryClient()
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [selectedItem, setSelectedItem] = React.useState(null)
  const [snackbar, setSnackbar] = React.useState({ open: false, message: '', severity: 'success' })

  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      await axios.delete(`/playwright/queue/${id}`)
      return id
    },
    onSuccess: (id) => {
      qc.invalidateQueries({ queryKey: ['queue'] })
      setSnackbar({ open: true, message: `Removed query ${id}`, severity: 'success' })
      setDialogOpen(false)
      setSelectedItem(null)
    },
    onError: (err) => {
      setSnackbar({ open: true, message: err?.message || 'Failed to remove query', severity: 'error' })
      setDialogOpen(false)
      setSelectedItem(null)
    },
  })

  const requestDelete = (item) => {
    setSelectedItem(item)
    setDialogOpen(true)
  }

  const confirmDelete = () => {
    if (!selectedItem?.id) return
    deleteMutation.mutate(selectedItem.id)
  }

  const closeSnackbar = () => setSnackbar((s) => ({ ...s, open: false }))

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
          <QueueItem
            key={item.id ?? item.pageUrl ?? `queue-item-${index}`}
            item={item}
            index={index}
            isLoading={deleteMutation.isLoading && selectedItem?.id === item.id}
            onRequestDelete={requestDelete}
          />
        ))}
      </Box>

      <ConfirmDialog
        open={dialogOpen}
        title="Remove query"
        content="Are you sure you want to remove this query from the queue? This action cannot be undone."
        itemLabel={selectedItem?.pageUrl ?? `Query #${selectedItem?.id ?? ''}`}
        loading={deleteMutation.isLoading}
        onClose={() => {
          setDialogOpen(false)
          setSelectedItem(null)
        }}
        onConfirm={confirmDelete}
        confirmText="Remove"
        cancelText="Cancel"
      />

      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={closeSnackbar}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={closeSnackbar} severity={snackbar.severity} sx={{ width: '100%' }}>
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  )
}
