import React from 'react'
import axios from 'axios'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Box, Container, Typography, CircularProgress, Alert, IconButton, Tooltip, Fade } from '@mui/material'
import DarkModeRoundedIcon from '@mui/icons-material/DarkModeRounded'
import LightModeRoundedIcon from '@mui/icons-material/LightModeRounded'
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded'
import { useColorMode } from './ThemeContext'
import AddQueryForm from './components/AddQueryForm'
import QueueList from './components/QueueList'

const fetchQueue = async () => {
  const { data } = await axios.get('/playwright/queue')
  return data.queue || []
}

export default function App() {
  const qc = useQueryClient()
  const { mode, toggleColorMode } = useColorMode()

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
            <QueueList queue={queue} />
          )}
        </Box>
      </Container>
    </Box>
  )
}
