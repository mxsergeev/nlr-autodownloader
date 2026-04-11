import React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Box, Container, Typography, CircularProgress, Alert, IconButton, Tooltip, Fade } from '@mui/material'
import DarkModeRoundedIcon from '@mui/icons-material/DarkModeRounded'
import LightModeRoundedIcon from '@mui/icons-material/LightModeRounded'
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded'
import { useColorMode } from './ThemeContext'
import AddQueryForm from './components/AddQueryForm'
import QueueList from './components/QueueList'
import { fetchQueue, addQuery } from './api/queue.api.js'

export default function App() {
  const qc = useQueryClient()
  const { mode, toggleColorMode } = useColorMode()
  const [pendingJobs, setPendingJobs] = React.useState({}) // { url: { status: 'loading' | 'error', message? } }

  const {
    data: queue = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['queue'],
    queryFn: fetchQueue,
    refetchInterval: (query) =>
      query.state.data?.some((q) => ['pending', 'downloading'].includes(q.status)) ? 500 : 3000,
  })

  const mutation = useMutation({
    mutationFn: (url) => addQuery(url),
    onSuccess: (data) => {
      if (data?.queue) qc.setQueryData(['queue'], data.queue)
      qc.invalidateQueries({ queryKey: ['queue'] })
    },
    onError: (err, url) => {
      setPendingJobs((prev) => ({
        ...prev,
        [url]: {
          status: 'error',
          message: err?.response?.data?.error || err?.message || 'Failed to add URL',
        },
      }))
    },
  })

  const handleAddUrl = (url) => {
    setPendingJobs((prev) => ({ ...prev, [url]: { status: 'loading' } }))
    mutation.mutate(url)
  }

  const queueUrls = React.useMemo(() => new Set(queue.map((item) => item.pageUrl).filter(Boolean)), [queue])

  React.useEffect(() => {
    setPendingJobs((prev) => {
      let changed = false
      const next = {}

      for (const [url, state] of Object.entries(prev)) {
        if (queueUrls.has(url)) {
          changed = true
          continue
        }

        next[url] = state
      }

      return changed ? next : prev
    })
  }, [queueUrls])

  const displayQueue = React.useMemo(() => {
    const pending = Object.entries(pendingJobs).map(([url, state]) => ({
      id: `pending-${url}`,
      pageUrl: url,
      status: state.status === 'error' ? 'search_failed' : 'pending',
      results: null,
      resultsPerPart: null,
      parts: null,
      searchResults: [],
      createdAt: new Date(),
      isPending: true,
      pendingError: state.message,
    }))
    const visiblePending = pending.filter((item) => !queueUrls.has(item.pageUrl))

    return [...visiblePending, ...queue]
  }, [pendingJobs, queue, queueUrls])

  return (
    <Box
      sx={{
        minHeight: '100vh',
        bgcolor: 'background.default',
        transition: 'background-color 0.2s ease',
      }}
    >
      {/* Header */}
      <Box
        component="header"
        sx={{
          borderBottom: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.paper',
          position: 'sticky',
          top: 0,
          zIndex: 10,
          backdropFilter: 'blur(8px)',
        }}
      >
        <Container maxWidth="md">
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              py: 1.5,
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 34,
                  height: 34,
                  borderRadius: 2,
                  bgcolor: 'primary.main',
                  color: '#fff',
                  flexShrink: 0,
                }}
              >
                <DownloadRoundedIcon sx={{ fontSize: 18 }} />
              </Box>
              <Box>
                <Typography variant="h5" component="h1" sx={{ fontSize: '1rem', lineHeight: 1.2 }}>
                  NLR Autodownloader
                </Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary', letterSpacing: '0.04em' }}>
                  Queue Manager
                </Typography>
              </Box>
            </Box>

            <Tooltip title={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
              <IconButton onClick={toggleColorMode} size="small" aria-label="toggle color mode">
                {mode === 'dark' ? <LightModeRoundedIcon fontSize="small" /> : <DarkModeRoundedIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
          </Box>
        </Container>
      </Box>

      {/* Main content */}
      <Container maxWidth="md">
        <Box sx={{ py: 4 }}>
          <AddQueryForm onSubmitUrl={handleAddUrl} isSubmitting={mutation.isPending} />

          <Fade in={mutation.isError} unmountOnExit>
            <Alert severity="error" sx={{ mb: 2 }}>
              Failed to add URL: {mutation.error?.message}
            </Alert>
          </Fade>

          <Fade in={mutation.isSuccess} unmountOnExit>
            <Alert severity="success" sx={{ mb: 2 }}>
              Query added to the queue.
            </Alert>
          </Fade>

          {isLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', pt: 6 }}>
              <CircularProgress size={32} thickness={3} />
            </Box>
          ) : isError ? (
            <Alert severity="error">Failed to load queue. Retrying…</Alert>
          ) : (
            <QueueList queue={displayQueue} />
          )}
        </Box>
      </Container>
    </Box>
  )
}
