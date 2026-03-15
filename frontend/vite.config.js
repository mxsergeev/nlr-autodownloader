import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

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

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/playwright': {
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
