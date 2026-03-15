import React, { useState } from 'react'
import axios from 'axios'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Container,
  Box,
  TextField,
  Button,
  Typography,
  List,
  ListItem,
  ListItemText,
  CircularProgress,
  Alert,
} from '@mui/material'

const fetchQueue = async () => {
  const { data } = await axios.get('/playwright/queue')
  return data.queue || []
}

export default function App() {
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [year, setYear] = useState('')

  const {
    data: queue = [],
    isLoading,
    isError,
  } = useQuery(['queue'], fetchQueue, {
    refetchInterval: 3000,
  })

  const mutation = useMutation(
    async (newQuery) => {
      const { data } = await axios.post('/playwright/queue', {
        queries: [newQuery],
      })
      return data
    },
    {
      onSuccess: () => qc.invalidateQueries(['queue']),
    },
  )

  const handleAdd = (e) => {
    e?.preventDefault()
    if (!q || !year) return
    mutation.mutate({ q, year: Number(year) })
    setQ('')
    setYear('')
  }

  return (
    <Container maxWidth="md" sx={{ mt: 4 }}>
      <Typography variant="h5" gutterBottom>
        NLR Autodownloader — Queue
      </Typography>

      <Box component="form" onSubmit={handleAdd} sx={{ display: 'flex', gap: 2, mb: 3 }}>
        <TextField
          label="Query / URL"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search phrase or Primo URL"
          fullWidth
        />
        <TextField
          label="Year"
          value={year}
          onChange={(e) => setYear(e.target.value)}
          sx={{ width: 120 }}
          type="number"
        />
        <Button variant="contained" type="submit" disabled={mutation.isLoading}>
          Add
        </Button>
      </Box>

      {mutation.isError && <Alert severity="error">Failed to add: {mutation.error?.message}</Alert>}
      {mutation.isSuccess && <Alert severity="success">Query added</Alert>}

      {isLoading ? (
        <CircularProgress />
      ) : isError ? (
        <Alert severity="error">Failed to load queue</Alert>
      ) : (
        <List>
          {queue.map((item) => (
            <ListItem key={`${item.q}_${item.year}`} divider>
              <ListItemText
                primary={`${item.q} — ${item.year}`}
                secondary={`status: ${item.status || 'unknown'} | results: ${item.results ?? 'N/A'} | created: ${item.createdAt ? new Date(item.createdAt).toLocaleString() : 'N/A'}`}
              />
            </ListItem>
          ))}
        </List>
      )}
    </Container>
  )
}
