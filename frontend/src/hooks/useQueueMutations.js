import React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { deleteQuery, retryQuery, pauseQuery, pauseItem, deleteItem } from '../api/queue.api.js'

/**
 * @typedef {{ open: boolean, message: string, severity: 'success' | 'error' }} SnackbarState
 */

/**
 * Provides mutations for delete, retry, pause, and per-item actions, plus shared snackbar state.
 * @returns {{
 *   deleteMutation: import('@tanstack/react-query').UseMutationResult,
 *   retryMutation: import('@tanstack/react-query').UseMutationResult,
 *   pauseMutation: import('@tanstack/react-query').UseMutationResult,
 *   pauseItemMutation: import('@tanstack/react-query').UseMutationResult,
 *   deleteItemMutation: import('@tanstack/react-query').UseMutationResult,
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

  const pauseItemMutation = useMutation({
    mutationFn: ({ queryId, itemId }) => pauseItem(queryId, itemId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queue'] })
    },
    onError: (err) => {
      const serverMsg = err?.response?.data?.error
      setSnackbar({ open: true, message: serverMsg || err?.message || 'Failed to pause item', severity: 'error' })
    },
  })

  const deleteItemMutation = useMutation({
    mutationFn: ({ queryId, itemId }) => deleteItem(queryId, itemId),
    onSuccess: (_, { itemId }) => {
      qc.invalidateQueries({ queryKey: ['queue'] })
      setSnackbar({ open: true, message: `Removed item ${itemId}`, severity: 'success' })
    },
    onError: (err) => {
      const serverMsg = err?.response?.data?.error
      setSnackbar({ open: true, message: serverMsg || err?.message || 'Failed to remove item', severity: 'error' })
    },
  })

  return { deleteMutation, retryMutation, pauseMutation, pauseItemMutation, deleteItemMutation, snackbar, closeSnackbar }
}
