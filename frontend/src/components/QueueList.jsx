import React from 'react'
import { List, ListItem, ListItemText, Typography } from '@mui/material'

function formatTimestamp(value) {
  if (!value) return 'N/A'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'N/A' : date.toLocaleString()
}

export default function QueueList({ queue }) {
  if (!queue || queue.length === 0) {
    return <Typography color="text.secondary">The queue is currently empty.</Typography>
  }

  return (
    <List>
      {queue.map((item, index) => {
        const primary = item.pageUrl ?? `Query #${item.id ?? index + 1}`
        const created = formatTimestamp(item.createdAt)
        const secondary = `status: ${item.status || 'unknown'} | results: ${item.results ?? 'N/A'} | created: ${created}`

        return (
          <ListItem key={item.id ?? item.pageUrl ?? `queue-item-${index}`} divider alignItems="flex-start">
            <ListItemText primary={primary} secondary={secondary} />
          </ListItem>
        )
      })}
    </List>
  )
}
