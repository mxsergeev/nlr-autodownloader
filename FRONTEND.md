Frontend (React + MUI + TanStack Query)

This repository now includes a lightweight React frontend at ./frontend. It lists current queries in the server queue and lets you add a new query (provide a search phrase or Primo URL and a year).

Quick start (development):

1. cd frontend
2. npm install
3. npm run dev

The Vite dev server proxies /playwright and /health to http://localhost:3333 by default. Ensure the server is running (docker-compose or npm start) on port 3333.

Build for production:

1. cd frontend
2. npm run build
3. Serve the generated dist/ directory with any static server or integrate into the server container.

Notes:

- Uses modern React (>=19), Material UI (v6) and @tanstack/react-query v5 for data fetching and cache management.
- The add form sends POST /playwright/queue with body { queries: [{ q, year }] }. Provide a year (number) because the server requires it.
