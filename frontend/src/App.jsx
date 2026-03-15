import React from 'react'
import axios from 'axios'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Container, Typography, CircularProgress, Alert } from '@mui/material'
import AddQueryForm from './components/AddQueryForm'
import QueueList from './components/QueueList'

const fetchQueue = async () => {
  const { data } = await axios.get('/playwright/queue')
  return data.queue || []
}

export default function App() {
  const qc = useQueryClient()

  const {
    data: queue = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['queue'],
    queryFn: fetchQueue,
    refetchInterval: 3000,
  })

  const mutation = useMutation({
    mutationFn: async (url) => {
      const { data } = await axios.post('/playwright/queue', {
        queries: [{ url }],
      })
      return data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['queue'] }),
  })

  const handleAddUrl = (url) => {
    mutation.mutate(url)
  }

  return (
    <Container maxWidth="md" sx={{ mt: 4 }}>
      <Typography variant="h5" gutterBottom>
        NLR Autodownloader — Queue
      </Typography>

      <AddQueryForm onSubmitUrl={handleAddUrl} isSubmitting={mutation.isLoading} />

      {mutation.isError && <Alert severity="error">Failed to add: {mutation.error?.message}</Alert>}
      {mutation.isSuccess && <Alert severity="success">Query added</Alert>}

      {isLoading ? (
        <CircularProgress />
      ) : isError ? (
        <Alert severity="error">Failed to load queue</Alert>
      ) : (
        <QueueList queue={queue} />
      )}
    </Container>
  )
}
