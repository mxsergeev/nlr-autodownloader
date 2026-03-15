import { Queue } from 'bullmq'
import Redis from 'ioredis'
import { redisOptions } from './redis'

export const connection = new Redis(redisOptions)

export const metadataQueue = new Queue('metadataQueue', { connection })
export const searchQueue = new Queue('searchQueue', { connection })
export const downloadQueue = new Queue('downloadQueue', { connection })
