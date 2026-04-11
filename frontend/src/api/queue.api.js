import axios from 'axios'

/** @returns {Promise<import('../../../shared/types.js').Query[]>} */
export const fetchQueue = () => axios.get('/api/queue').then((r) => r.data.queue ?? [])

/**
 * @param {string} url
 * @returns {Promise<{ failed: any[], queue: import('../../../shared/types.js').Query[] }>}
 */
export const addQuery = (url) => axios.post('/api/queue', { queries: [{ url }] }).then((r) => r.data)

/** @returns {Promise<{ removed: number }>} */
export const deleteQuery = (id) => axios.delete(`/api/queue/${id}`).then((r) => r.data)

/** @returns {Promise<{ retried: number }>} */
export const retryQuery = (id) => axios.post(`/api/queue/${id}/retry`).then((r) => r.data)

/** @returns {Promise<{ paused: boolean, id: number, status: string }>} */
export const pauseQuery = (id) => axios.post(`/api/queue/${id}/pause`).then((r) => r.data)

/** @returns {Promise<{ paused: boolean, id: number }>} */
export const pauseItem = (queryId, itemId) =>
  axios.post(`/api/queue/${queryId}/items/${itemId}/pause`).then((r) => r.data)

/** @returns {Promise<{ removed: number }>} */
export const deleteItem = (queryId, itemId) =>
  axios.delete(`/api/queue/${queryId}/items/${itemId}`).then((r) => r.data)
