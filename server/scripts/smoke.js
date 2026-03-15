import fetch from 'node-fetch'
import { connection } from '../redis.js'

const SERVER_URL = `http://localhost:${process.env.SERVER_PORT || 3333}`

async function checkHttp() {
  try {
    const res = await fetch(`${SERVER_URL}/health`, { timeout: 5000 })
    if (res.status !== 200) {
      console.error('Health endpoint returned', res.status)
      return false
    }
    const json = await res.json()
    if (json && (json.status === 'ok' || res.status === 200)) {
      console.log('HTTP: OK')
      return true
    }
    console.error('Health endpoint returned unexpected body', json)
    return false
  } catch (err) {
    console.error('HTTP check failed:', err.message || err)
    return false
  }
}

async function checkRedis() {
  try {
    const pong = await connection.ping()
    if (pong) {
      console.log('Redis: PONG')
      return true
    }
    console.error('Redis did not respond with PONG', pong)
    return false
  } catch (err) {
    console.error('Redis check failed:', err.message || err)
    return false
  } finally {
    try {
      await connection.quit()
    } catch {}
  }
}

async function main() {
  const httpOk = await checkHttp()
  const redisOk = await checkRedis()

  if (httpOk && redisOk) {
    console.log('SMOKE: All checks passed')
    process.exit(0)
  }

  console.error('SMOKE: Checks failed')
  process.exit(2)
}

main()
