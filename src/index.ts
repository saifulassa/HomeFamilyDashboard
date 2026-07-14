import { Elysia } from 'elysia'
import { cors } from '@elysiajs/cors'
import { join } from 'node:path'
import { createTables, seedDefaults, seedChecklists, seedStock } from './db/schema'
import { healthCheck } from './routes/health'
import { broadcast, setServer } from './ws'
import db from './db/db'

createTables()
seedDefaults()
seedChecklists()
seedStock()

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

  // ── Checklist CRUD ──────────────────────────────────────────

  .ws('/ws/checklist', {
    open(ws) { ws.subscribe('checklist') },
    message(ws, msg) { ws.send(msg) },
  })

  .get('/api/checklists', () => {
    const now = new Date()
    const today = now.toISOString().split('T')[0]
    const day = now.getDay()
    const monday = new Date(now)
    monday.setDate(now.getDate() + (day === 0 ? -6 : 1 - day))
    const weekStart = monday.toISOString().split('T')[0]
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
    const weekEnd = new Date(monday); weekEnd.setDate(weekEnd.getDate() + 6)
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1)

    const checklists = db.query('SELECT * FROM checklists ORDER BY sort_order ASC, id ASC').all() as any[]

    const data = checklists.map((cl) => {
      const [pStart, pEnd] = cl.type === 'daily'
        ? [today, today]
        : cl.type === 'weekly'
        ? [weekStart, weekEnd.toISOString().split('T')[0]]
        : [monthStart, monthEnd.toISOString().split('T')[0]]
      const items = db.query(`
        SELECT ci.*,
          CASE WHEN cc.id IS NOT NULL THEN 1 ELSE 0 END as completed,
          COALESCE(cc.completed_by, '') as completed_by
        FROM checklist_items ci
        LEFT JOIN checklist_completions cc ON ci.id = cc.item_id
          AND cc.completed_date BETWEEN ? AND ?
        WHERE ci.checklist_id = ?
        ORDER BY ci.sort_order ASC, ci.id ASC
      `).all([pStart, pEnd, cl.id])
      return { ...cl, items }
    })

    return { data }
  })

  .post('/api/checklists', (ctx) => {
    const { title, type } = ctx.body as any
    const r = db.run('INSERT INTO checklists (title, type) VALUES (?, ?)', title, type || 'daily')
    const cl = db.query('SELECT * FROM checklists WHERE id = ?').get(r.lastInsertRowid)
    broadcast({ type: 'checklist', action: 'create', checklist: cl }, 'checklist')
    return { data: cl }
  })

  .patch('/api/checklists/:id', (ctx) => {
    const id = ctx.params.id
    const { title, sort_order } = ctx.body as any
    if (title !== undefined) db.run('UPDATE checklists SET title = ? WHERE id = ?', title, id)
    if (sort_order !== undefined) db.run('UPDATE checklists SET sort_order = ? WHERE id = ?', sort_order, id)
    const cl = db.query('SELECT * FROM checklists WHERE id = ?').get(id)
    broadcast({ type: 'checklist', action: 'update', checklist: cl }, 'checklist')
    return { data: cl }
  })

  .delete('/api/checklists/:id', (ctx) => {
    const id = ctx.params.id
    db.run('DELETE FROM checklists WHERE id = ?', id)
    broadcast({ type: 'checklist', action: 'delete', id: Number(id) }, 'checklist')
    return { success: true }
  })

  // ── Checklist Items ─────────────────────────────────────────

  .post('/api/checklists/:id/items', (ctx) => {
    const checklist_id = ctx.params.id
    const { label, type, day_of_week, day_of_month } = ctx.body as any
    const r = db.run(
      'INSERT INTO checklist_items (checklist_id, label, type, day_of_week, day_of_month) VALUES (?, ?, ?, ?, ?)',
      checklist_id, label, type || 'daily', day_of_week || null, day_of_month || null
    )
    const item = db.query('SELECT * FROM checklist_items WHERE id = ?').get(r.lastInsertRowid)
    broadcast({ type: 'checklist_item', action: 'create', item, checklistId: Number(checklist_id) }, 'checklist')
    return { data: item }
  })

  .patch('/api/checklists/:id/items/:itemId', (ctx) => {
    const { id, itemId } = ctx.params
    const { label, sort_order, day_of_week, day_of_month } = ctx.body as any
    if (label !== undefined) db.run('UPDATE checklist_items SET label = ? WHERE id = ?', label, itemId)
    if (sort_order !== undefined) db.run('UPDATE checklist_items SET sort_order = ? WHERE id = ?', sort_order, itemId)
    if (day_of_week !== undefined) db.run('UPDATE checklist_items SET day_of_week = ? WHERE id = ?', day_of_week, itemId)
    if (day_of_month !== undefined) db.run('UPDATE checklist_items SET day_of_month = ? WHERE id = ?', day_of_month, itemId)
    const item = db.query('SELECT * FROM checklist_items WHERE id = ?').get(itemId)
    broadcast({ type: 'checklist_item', action: 'update', item, checklistId: Number(id) }, 'checklist')
    return { data: item }
  })

  .delete('/api/checklists/:id/items/:itemId', (ctx) => {
    const { id, itemId } = ctx.params
    db.run('DELETE FROM checklist_items WHERE id = ?', itemId)
    broadcast({ type: 'checklist_item', action: 'delete', itemId: Number(itemId), checklistId: Number(id) }, 'checklist')
    return { success: true }
  })

  // ── Checklist Toggle ────────────────────────────────────────

  .patch('/api/checklists/:id/items/:itemId/toggle', (ctx) => {
    const { id, itemId } = ctx.params
    const { completed_by } = ctx.body as any

    const item = db.query('SELECT * FROM checklist_items WHERE id = ?').get(itemId) as any
    if (!item) return new Response('Not Found', { status: 404 })

    const now = new Date()
    const today = now.toISOString().split('T')[0]
    const day = now.getDay()
    const monday = new Date(now)
    monday.setDate(now.getDate() + (day === 0 ? -6 : 1 - day))
    const weekStart = monday.toISOString().split('T')[0]
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`

    const periodStart = item.type === 'daily' ? today : item.type === 'weekly' ? weekStart : monthStart

    const existing = db.query(
      'SELECT id FROM checklist_completions WHERE item_id = ? AND completed_date >= ? ORDER BY completed_date DESC LIMIT 1'
    ).get(itemId, periodStart) as any

    if (existing) {
      db.run('DELETE FROM checklist_completions WHERE id = ?', existing.id)
      broadcast({ type: 'checklist_toggle', action: 'uncheck', itemId: Number(itemId), checklistId: Number(id) }, 'checklist')
      return { data: { id: itemId, completed: false } }
    }

    const name = (completed_by || 'Ayah').trim()
    db.run(
      'INSERT INTO checklist_completions (item_id, completed_by, completed_date) VALUES (?, ?, ?)',
      itemId, name, today
    )
    broadcast({ type: 'checklist_toggle', action: 'check', itemId: Number(itemId), checklistId: Number(id), completed_by: name }, 'checklist')
    return { data: { id: itemId, completed: true, completed_by: name } }
  })

  // ── Stock ──────────────────────────────────────────────────

  .ws('/ws/stock', {
    open(ws) { ws.subscribe('stock') },
    message(ws, msg) { ws.send(msg) },
  })

  .get('/api/stock', () => {
    const rows = db.query('SELECT * FROM stock_items ORDER BY category ASC, name ASC').all() as any[]
    const data = rows.map((r) => ({
      ...r,
      status: r.current_qty > r.min_threshold ? 'green'
        : r.current_qty > 0 ? 'yellow'
        : 'red'
    }))
    return { data }
  })

  .post('/api/stock', (ctx) => {
    const { name, category, current_qty, min_threshold, unit } = ctx.body as any
    const r = db.run(
      'INSERT INTO stock_items (name, category, current_qty, min_threshold, unit) VALUES (?, ?, ?, ?, ?)',
      name, category || 'Lainnya', current_qty || 0, min_threshold || 1, unit || 'pcs'
    )
    const item = db.query('SELECT * FROM stock_items WHERE id = ?').get(r.lastInsertRowid)
    broadcast({ type: 'stock', action: 'create', item }, 'stock')
    return { data: item }
  })

  .patch('/api/stock/:id', (ctx) => {
    const id = ctx.params.id
    const { name, category, current_qty, min_threshold, unit } = ctx.body as any
    if (name !== undefined) db.run('UPDATE stock_items SET name = ? WHERE id = ?', name, id)
    if (category !== undefined) db.run('UPDATE stock_items SET category = ? WHERE id = ?', category, id)
    if (current_qty !== undefined) db.run('UPDATE stock_items SET current_qty = ? WHERE id = ?', current_qty, id)
    if (min_threshold !== undefined) db.run('UPDATE stock_items SET min_threshold = ? WHERE id = ?', min_threshold, id)
    if (unit !== undefined) db.run('UPDATE stock_items SET unit = ? WHERE id = ?', unit, id)
    db.run("UPDATE stock_items SET updated_at = datetime('now', 'localtime') WHERE id = ?", id)
    const item = db.query('SELECT * FROM stock_items WHERE id = ?').get(id)
    broadcast({ type: 'stock', action: 'update', item }, 'stock')
    return { data: item }
  })

  .delete('/api/stock/:id', (ctx) => {
    const id = ctx.params.id
    db.run('DELETE FROM stock_items WHERE id = ?', id)
    broadcast({ type: 'stock', action: 'delete', id: Number(id) }, 'stock')
    return { success: true }
  })

  .post('/api/stock/:id/adjust', (ctx) => {
    const id = ctx.params.id
    const { delta } = ctx.body as any
    const item = db.query('SELECT * FROM stock_items WHERE id = ?').get(id) as any
    if (!item) return new Response('Not Found', { status: 404 })
    const newQty = Math.max(0, (item.current_qty || 0) + (delta || 0))
    db.run('UPDATE stock_items SET current_qty = ?, updated_at = datetime(\'now\', \'localtime\') WHERE id = ?', newQty, id)
    const updated = db.query('SELECT * FROM stock_items WHERE id = ?').get(id) as any
    updated.status = updated.current_qty > updated.min_threshold ? 'green'
      : updated.current_qty > 0 ? 'yellow' : 'red'
    broadcast({ type: 'stock', action: 'adjust', item: updated }, 'stock')
    return { data: updated }
  })

  // ── Settings ────────────────────────────────────────────────

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
