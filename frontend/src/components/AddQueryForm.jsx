import React, { useState } from 'react'
import { Box, TextField, Button } from '@mui/material'

const helperTextFallback = 'Queue a Primo URL (results page) to start the download.'

export default function AddQueryForm({ onSubmitUrl, isSubmitting }) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')

  const handleChange = (event) => {
    setUrl(event.target.value)
    if (error) {
      setError('')
    }
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
    <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', gap: 2, mb: 3 }}>
      <TextField
        label="Primo URL"
        placeholder="https://..."
        value={url}
        onChange={handleChange}
        type="url"
        fullWidth
        error={Boolean(error)}
        helperText={error || helperTextFallback}
        disabled={isSubmitting}
        required
      />
      <Button variant="contained" type="submit" disabled={isSubmitting}>
        Add
      </Button>
    </Box>
  )
}
