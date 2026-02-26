import IORedis from 'ioredis'

export const credentials = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB || '0', 10),
}

export function createConnection() {
  const connection = new IORedis({
    ...credentials,
    maxRetriesPerRequest: null,
  })

  return connection
}

export const connection = createConnection()
