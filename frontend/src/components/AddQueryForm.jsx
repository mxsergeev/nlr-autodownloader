import React, { useState } from 'react'
import { Box, TextField, Button, InputAdornment } from '@mui/material'
import LinkRoundedIcon from '@mui/icons-material/LinkRounded'
import AddRoundedIcon from '@mui/icons-material/AddRounded'

const helperTextFallback = 'Queue a Primo URL (results page) to start the download.'

export default function AddQueryForm({ onSubmitUrl, isSubmitting }) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')

  const handleChange = (event) => {
    setUrl(event.target.value)
    if (error) setError('')
  }

  const validateUrl = (value) => {
    try {
      new URL(value)
      return true
    } catch {
      return false
    }
  }

  const handleSubmit = (event) => {
    event.preventDefault()
    const trimmed = url.trim()

    if (!trimmed) {
      setError('Please enter a URL before submitting.')
      return
    }

    if (!validateUrl(trimmed)) {
      setError('Please enter a valid URL.')
      return
    }

    onSubmitUrl(trimmed)
    setUrl('')
  }

  return (
    <Box component="form" onSubmit={handleSubmit} sx={{ mb: 3 }}>
      <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
        <TextField
          placeholder="https://primo.example.edu/results?query=…"
          value={url}
          onChange={handleChange}
          type="url"
          fullWidth
          error={Boolean(error)}
          helperText={error || helperTextFallback}
          disabled={isSubmitting}
          required
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <LinkRoundedIcon fontSize="small" sx={{ color: error ? 'error.main' : 'text.secondary' }} />
                </InputAdornment>
              ),
            },
          }}
          sx={{
            '& .MuiOutlinedInput-root': {
              bgcolor: 'background.paper',
            },
          }}
        />
        <Button
          variant="contained"
          type="submit"
          disabled={isSubmitting}
          startIcon={<AddRoundedIcon />}
          sx={{
            height: 40,
            mt: '1px',
            whiteSpace: 'nowrap',
            flexShrink: 0,
            px: 2.5,
          }}
        >
          Add URL
        </Button>
      </Box>
    </Box>
  )
}
