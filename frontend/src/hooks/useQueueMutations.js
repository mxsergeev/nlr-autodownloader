import React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { deleteQuery, retryQuery, pauseQuery, pauseItem, deleteItem } from '../api/queue.api.js'

/**
 * @typedef {{ open: boolean, message: string, severity: 'success' | 'error' }} SnackbarState
 */

/**
 * Provides mutations for delete, retry, pause, and per-item actions, plus shared snackbar state.
 * All mutations update the cache optimistically and sync with the server via onSettled.
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
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['queue'] })
      const prev = qc.getQueryData(['queue'])
      qc.setQueryData(['queue'], (old) => old?.filter((q) => q.id !== id) ?? [])
      return { prev }
    },
    onError: (_err, _id, ctx) => {
      qc.setQueryData(['queue'], ctx?.prev)
      setSnackbar({ open: true, message: 'Failed to remove query', severity: 'error' })
    },
    onSuccess: (_, id) => {
      setSnackbar({ open: true, message: `Removed query ${id}`, severity: 'success' })
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['queue'] }),
  })

  const retryMutation = useMutation({
    mutationFn: (id) => retryQuery(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['queue'] })
      const prev = qc.getQueryData(['queue'])
      qc.setQueryData(['queue'], (old) =>
        old?.map((q) => (q.id === id ? { ...q, status: 'pending' } : q)) ?? []
      )
      return { prev }
    },
    onError: (_err, _id, ctx) => {
      qc.setQueryData(['queue'], ctx?.prev)
      setSnackbar({
        open: true,
        message: _err?.response?.data?.error || _err?.message || 'Failed to retry query',
        severity: 'error',
      })
    },
    onSuccess: (_, id) => {
      setSnackbar({ open: true, message: `Retrying query ${id}`, severity: 'success' })
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['queue'] }),
  })

  const pauseMutation = useMutation({
    mutationFn: (id) => pauseQuery(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['queue'] })
      const prev = qc.getQueryData(['queue'])
      qc.setQueryData(['queue'], (old) =>
        old?.map((q) => {
          if (q.id !== id) return q
          return { ...q, status: q.status === 'paused' ? 'downloading' : 'paused' }
        }) ?? []
      )
      return { prev }
    },
    onError: (_err, _id, ctx) => {
      qc.setQueryData(['queue'], ctx?.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['queue'] }),
  })

  const pauseItemMutation = useMutation({
    mutationFn: ({ queryId, itemId }) => pauseItem(queryId, itemId),
    onMutate: async ({ queryId, itemId }) => {
      await qc.cancelQueries({ queryKey: ['queue'] })
      const prev = qc.getQueryData(['queue'])
      qc.setQueryData(['queue'], (old) =>
        old?.map((q) => {
          if (q.id !== queryId) return q
          return {
            ...q,
            searchResults: q.searchResults?.map((r) =>
              r.id === itemId ? { ...r, status: r.status === 'paused' ? 'pending' : 'paused' } : r
            ),
          }
        }) ?? []
      )
      return { prev }
    },
    onError: (_err, _vars, ctx) => {
      qc.setQueryData(['queue'], ctx?.prev)
      setSnackbar({
        open: true,
        message: _err?.response?.data?.error || _err?.message || 'Failed to pause item',
        severity: 'error',
      })
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['queue'] }),
  })

  const deleteItemMutation = useMutation({
    mutationFn: ({ queryId, itemId }) => deleteItem(queryId, itemId),
    onMutate: async ({ queryId, itemId }) => {
      await qc.cancelQueries({ queryKey: ['queue'] })
      const prev = qc.getQueryData(['queue'])
      qc.setQueryData(['queue'], (old) =>
        old?.map((q) => {
          if (q.id !== queryId) return q
          return {
            ...q,
            searchResults: q.searchResults?.filter((r) => r.id !== itemId),
            results: q.results != null ? q.results - 1 : q.results,
          }
        }) ?? []
      )
      return { prev }
    },
    onError: (_err, _vars, ctx) => {
      qc.setQueryData(['queue'], ctx?.prev)
      setSnackbar({
        open: true,
        message: _err?.response?.data?.error || _err?.message || 'Failed to remove item',
        severity: 'error',
      })
    },
    onSuccess: (_, { itemId }) => {
      setSnackbar({ open: true, message: `Removed item ${itemId}`, severity: 'success' })
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['queue'] }),
  })

  return { deleteMutation, retryMutation, pauseMutation, pauseItemMutation, deleteItemMutation, snackbar, closeSnackbar }
}
