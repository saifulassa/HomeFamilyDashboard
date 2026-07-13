import db from '../db/db'

export function healthCheck() {
  const dbOk = db.query('SELECT 1 as ok').get() as { ok: number }
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    timezone: 'Asia/Jakarta',
    db: dbOk.ok === 1 ? 'connected' : 'error',
  }
}
