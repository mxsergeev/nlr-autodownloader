import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { existsSync } from 'node:fs'

/*
  Make the proxy target configurable from the environment so that:
  - running in Docker Compose the frontend can use `VITE_SERVER_HOST=server`
  - running locally you can use `VITE_SERVER_HOST=localhost`
  Vite exposes env vars prefixed with VITE_ to the client, but this
  config runs in Node, so we read process.env directly here.
*/
const serverHost = process.env.VITE_SERVER_HOST || 'server'
const serverPort = process.env.VITE_SERVER_PORT || '3333'
const targetBase = `http://${serverHost}:${serverPort}`

// In Docker the frontend source lands at /app/ (no frontend/ prefix), so ../shared
// resolves to /shared/ which doesn't exist there. Shared is mounted at /app/shared/.
const localShared = fileURLToPath(new URL('../shared', import.meta.url))
const sharedAlias = existsSync(localShared) ? localShared : fileURLToPath(new URL('./shared', import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': sharedAlias,
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        // proxy target is now configurable via VITE_SERVER_HOST / VITE_SERVER_PORT
        target: targetBase,
        changeOrigin: true,
        secure: false,
      },
      '/health': {
        target: targetBase,
        changeOrigin: true,
        secure: false,
      },
    },
  },
})
