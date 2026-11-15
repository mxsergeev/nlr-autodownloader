export function assertOk(response, url) {
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).pathname}`)
  return response
}
