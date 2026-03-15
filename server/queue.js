import { Queue } from 'bullmq'
import Redis from 'ioredis'

const redisOptions = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB || '0', 10),
  maxRetriesPerRequest: null,
}

export const connection = new Redis(redisOptions)

export const metadataQueue = new Queue('metadataQueue', { connection })
export const searchQueue = new Queue('searchQueue', { connection })
export const downloadQueue = new Queue('downloadQueue', { connection })
