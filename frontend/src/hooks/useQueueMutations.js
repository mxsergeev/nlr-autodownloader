import React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { deleteQuery, retryQuery, pauseQuery } from '../api/queue.api.js'

/**
 * @typedef {{ open: boolean, message: string, severity: 'success' | 'error' }} SnackbarState
 */

/**
 * Provides mutations for delete, retry, and pause queue actions, plus shared snackbar state.
 * @returns {{
 *   deleteMutation: import('@tanstack/react-query').UseMutationResult,
 *   retryMutation: import('@tanstack/react-query').UseMutationResult,
 *   pauseMutation: import('@tanstack/react-query').UseMutationResult,
 *   snackbar: SnackbarState,
 *   closeSnackbar: () => void,
 * }}
 */
export function useQueueMutations() {
  const qc = useQueryClient()
  const [snackbar, setSnackbar] = React.useState({ open: false, message: '', severity: 'success' })

  const closeSnackbar = () => setSnackbar((s) => ({ ...s, open: false }))

  const deleteMutation = useMutation({
    mutationFn: (id) => deleteQuery(id),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['queue'] })
      setSnackbar({ open: true, message: `Removed query ${id}`, severity: 'success' })
    },
    onError: (err) => {
      setSnackbar({ open: true, message: err?.message || 'Failed to remove query', severity: 'error' })
    },
  })

  const retryMutation = useMutation({
    mutationFn: (id) => retryQuery(id),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['queue'] })
      setSnackbar({ open: true, message: `Retrying query ${id}`, severity: 'success' })
    },
    onError: (err) => {
      const serverMsg = err?.response?.data?.error
      setSnackbar({
        open: true,
        message: serverMsg || err?.message || 'Failed to retry query',
        severity: 'error',
      })
    },
  })

  const pauseMutation = useMutation({
    mutationFn: (id) => pauseQuery(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queue'] })
    },
  })

  return { deleteMutation, retryMutation, pauseMutation, snackbar, closeSnackbar }
}
