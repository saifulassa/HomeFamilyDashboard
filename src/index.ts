import { Elysia } from 'elysia'
import { cors } from '@elysiajs/cors'
import { join } from 'node:path'
import { createTables, seedDefaults } from './db/schema'
import { healthCheck } from './routes/health'
import { broadcast, setServer } from './ws'
import db from './db/db'

createTables()
seedDefaults()

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001

const app = new Elysia()
  .use(cors())
  .get('/api/health', () => healthCheck())
  .get('/api/status', () => ({
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    version: Bun.version,
  }))
  .get('/api/events', () => {
    const rows = db.query('SELECT * FROM events ORDER BY event_date ASC, id ASC').all()
    return { data: rows }
  })
  .ws('/ws/events', {
    open(ws) { ws.subscribe('events') },
    message(ws, msg) { ws.send(msg) },
  })
  .post('/api/events', (ctx) => {
    const { title, description, event_date, time, color } = ctx.body as any
    const r = db.run(
      'INSERT INTO events (title, description, event_date, time, color) VALUES (?, ?, ?, ?, ?)',
      title, description || '', event_date, time || '', color || '#1f6feb'
    )
    const event = db.query('SELECT * FROM events WHERE id = ?').get(r.lastInsertRowid)
    broadcast({ type: 'event', action: 'create', event })
    return { data: event }
  })
  .patch('/api/events/:id', (ctx) => {
    const id = ctx.params.id
    const updates = ctx.body as Record<string, any>
    const fields: string[] = []
    const vals: any[] = []
    for (const k of ['title', 'description', 'event_date', 'time', 'color']) {
      if (updates[k] !== undefined) { fields.push(`${k} = ?`); vals.push(updates[k]) }
    }
    if (!fields.length) return { data: null }
    fields.push("updated_at = datetime('now', 'localtime')")
    vals.push(id)
    db.run(`UPDATE events SET ${fields.join(', ')} WHERE id = ?`, ...vals)
    const event = db.query('SELECT * FROM events WHERE id = ?').get(id)
    broadcast({ type: 'event', action: 'update', event })
    return { data: event }
  })
  .delete('/api/events/:id', (ctx) => {
    const id = ctx.params.id
    db.run('DELETE FROM events WHERE id = ?', id)
    broadcast({ type: 'event', action: 'delete', id: Number(id) })
    return { success: true }
  })
  .get('/api/settings', () => {
    const rows = db.query('SELECT key, value FROM family_settings').all() as { key: string; value: string }[]
    const map: Record<string, string> = {}
    for (const r of rows) map[r.key] = r.value
    return { data: map }
  })
  .patch('/api/settings', (ctx) => {
    const updates = ctx.body as Record<string, string>
    for (const [key, value] of Object.entries(updates)) {
      db.run(
        `INSERT INTO family_settings (key, value, updated_at) VALUES (?, ?, datetime('now', 'localtime'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, value]
      )
    }
    return { success: true }
  })
  .get('/*', async ({ path }) => {
    const publicDir = join(import.meta.dir, '..', 'public')
    const filePath = path === '/' ? '/index.html' : path
    const file = Bun.file(join(publicDir, filePath))
    if (await file.exists()) return new Response(file)
    return new Response('Not Found', { status: 404 })
  })
  .listen(PORT)

setServer(app.server!)
console.log(`🏠 Tomo Family Hub running at http://localhost:${PORT}`)

export type App = typeof app
