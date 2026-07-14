import { Elysia } from 'elysia'
import { cors } from '@elysiajs/cors'
import { join } from 'node:path'
import { createTables, seedDefaults, seedChecklists, seedStock, seedMemos, seedPin, seedHealth } from './db/schema'
import { healthCheck } from './routes/health'
import { broadcast, setServer } from './ws'
import db from './db/db'
import { createHash } from 'node:crypto'
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

// PIN state
const pinTokens = new Map<string, number>()
const pinAttempts = new Map<string, { count: number; blockedUntil: number }>()
function requirePin(ctx: any): boolean {
  const token = ctx.request.headers.get('x-pin-token')
  if (!token) return false
  const expiry = pinTokens.get(token)
  if (!expiry || Date.now() > expiry) { pinTokens.delete(token); return false }
  return true
}

createTables()
seedDefaults()
seedChecklists()
seedStock()
seedMemos()
seedPin()
seedHealth()

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001

const app = new Elysia()
  .use(cors())
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

  // ── Memo ───────────────────────────────────────────────────

  .ws('/ws/memo', {
    open(ws) { ws.subscribe('memo') },
    message(ws, msg) { ws.send(msg) },
  })

  .get('/api/memos', () => {
    const data = db.query('SELECT * FROM memos ORDER BY is_pinned DESC, created_at DESC').all()
    return { data }
  })

  .post('/api/memos', (ctx) => {
    const { content, color } = ctx.body as any
    const r = db.run('INSERT INTO memos (content, color, is_pinned) VALUES (?, ?, 0)',
      content, color || '#FEF3C7')
    const memo = db.query('SELECT * FROM memos WHERE id = ?').get(r.lastInsertRowid)
    broadcast({ type: 'memo', action: 'create', memo }, 'memo')
    return { data: memo }
  })

  .patch('/api/memos/:id', (ctx) => {
    const id = ctx.params.id
    const { content, color, is_pinned } = ctx.body as any
    if (content !== undefined) db.run('UPDATE memos SET content = ? WHERE id = ?', content, id)
    if (color !== undefined) db.run('UPDATE memos SET color = ? WHERE id = ?', color, id)
    if (is_pinned !== undefined) db.run('UPDATE memos SET is_pinned = ? WHERE id = ?', is_pinned ? 1 : 0, id)
    db.run("UPDATE memos SET updated_at = datetime('now', 'localtime') WHERE id = ?", id)
    const memo = db.query('SELECT * FROM memos WHERE id = ?').get(id)
    broadcast({ type: 'memo', action: 'update', memo }, 'memo')
    return { data: memo }
  })

  .delete('/api/memos/:id', (ctx) => {
    const id = ctx.params.id
    db.run('DELETE FROM memos WHERE id = ?', id)
    broadcast({ type: 'memo', action: 'delete', id: Number(id) }, 'memo')
    return { success: true }
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

  // ── PIN + Health ──────────────────────────────────────────

  .post('/api/pin/verify', (ctx) => {
    const ip = ctx.request.headers.get('x-forwarded-for') || 'local'
    const now = Date.now()
    const attempt = pinAttempts.get(ip) || { count: 0, blockedUntil: 0 }

    if (now < attempt.blockedUntil) {
      const remaining = Math.ceil((attempt.blockedUntil - now) / 1000)
      return { success: false, error: `Terlalu banyak percobaan. Coba lagi dalam ${remaining} detik.`, blocked: true }
    }

    const { pin } = ctx.body as any
    const storedHash = db.query("SELECT value FROM family_settings WHERE key = 'pin_hash'").get() as any
    const valid = storedHash && sha256(String(pin || '')) === storedHash.value

    if (!valid) {
      attempt.count++
      if (attempt.count >= 3) attempt.blockedUntil = now + 5 * 60 * 1000
      pinAttempts.set(ip, attempt)
      return { success: false, error: 'PIN salah', attempts_remaining: Math.max(0, 3 - attempt.count) }
    }

    // Reset attempts on success
    pinAttempts.delete(ip)

    // Generate token (valid 1 hour)
    const token = sha256(`${ip}-${now}-${Math.random()}`)
    pinTokens.set(token, now + 3600 * 1000)
    return { success: true, token }
  })

  // ── Health Profiles ────────────────────────────────────────

  .ws('/ws/health', {
    open(ws) { ws.subscribe('health') },
    message(ws, msg) { ws.send(msg) },
  })

  .get('/api/health/profiles', () => {
    const profiles = db.query('SELECT * FROM health_profiles ORDER BY role ASC, id ASC').all() as any[]
    const data = profiles.map((p) => {
      const latestBP = db.query(
        "SELECT systolic, diastolic, date, notes FROM health_measurements WHERE profile_id = ? AND type = 'bp' ORDER BY date DESC LIMIT 1"
      ).get(p.id) as any
      const latestWeight = db.query(
        "SELECT value, date FROM health_measurements WHERE profile_id = ? AND type = 'weight' ORDER BY date DESC LIMIT 1"
      ).get(p.id) as any
      const latestHeight = db.query(
        "SELECT value, date FROM health_measurements WHERE profile_id = ? AND type = 'height' ORDER BY date DESC LIMIT 1"
      ).get(p.id) as any
      return { ...p, latestBP, latestWeight, latestHeight }
    })
    return { data }
  })

  .post('/api/health/profiles', (ctx) => {
    if (!requirePin(ctx)) return new Response('Unauthorized', { status: 401 })
    const { name, role, birth_date, gender } = ctx.body as any
    const r = db.run('INSERT INTO health_profiles (name, role, birth_date, gender) VALUES (?, ?, ?, ?)',
      name, role, birth_date || null, gender || null)
    const profile = db.query('SELECT * FROM health_profiles WHERE id = ?').get(r.lastInsertRowid)
    broadcast({ type: 'health', action: 'create_profile', profile }, 'health')
    return { data: profile }
  })

  .patch('/api/health/profiles/:id', (ctx) => {
    if (!requirePin(ctx)) return new Response('Unauthorized', { status: 401 })
    const id = ctx.params.id
    const { name, birth_date, gender } = ctx.body as any
    if (name !== undefined) db.run('UPDATE health_profiles SET name = ? WHERE id = ?', name, id)
    if (birth_date !== undefined) db.run('UPDATE health_profiles SET birth_date = ? WHERE id = ?', birth_date, id)
    if (gender !== undefined) db.run('UPDATE health_profiles SET gender = ? WHERE id = ?', gender, id)
    const profile = db.query('SELECT * FROM health_profiles WHERE id = ?').get(id)
    return { data: profile }
  })

  .delete('/api/health/profiles/:id', (ctx) => {
    if (!requirePin(ctx)) return new Response('Unauthorized', { status: 401 })
    db.run('DELETE FROM health_profiles WHERE id = ?', ctx.params.id)
    return { success: true }
  })

  // ── Health Measurements ───────────────────────────────────

  .get('/api/health/profiles/:id/measurements', (ctx) => {
    const type = ctx.query.type || ''
    const sql = type
      ? 'SELECT * FROM health_measurements WHERE profile_id = ? AND type = ? ORDER BY date DESC, id DESC'
      : 'SELECT * FROM health_measurements WHERE profile_id = ? ORDER BY date DESC, id DESC'
    const data = type ? db.query(sql).all([ctx.params.id, type]) : db.query(sql).all([ctx.params.id])
    return { data }
  })

  .post('/api/health/profiles/:id/measurements', (ctx) => {
    if (!requirePin(ctx)) return new Response('Unauthorized', { status: 401 })
    const { type, value, systolic, diastolic, date, notes } = ctx.body as any
    const r = db.run(
      'INSERT INTO health_measurements (profile_id, type, value, systolic, diastolic, date, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ctx.params.id, type, value || null, systolic || null, diastolic || null, date || new Date().toISOString().split('T')[0], notes || ''
    )
    const row = db.query('SELECT * FROM health_measurements WHERE id = ?').get(r.lastInsertRowid)
    return { data: row }
  })

  // ── Immunizations ─────────────────────────────────────────

  .get('/api/health/profiles/:id/immunizations', (ctx) => {
    const data = db.query('SELECT * FROM immunizations WHERE profile_id = ? ORDER BY date DESC').all([ctx.params.id])
    return { data }
  })

  .post('/api/health/profiles/:id/immunizations', (ctx) => {
    if (!requirePin(ctx)) return new Response('Unauthorized', { status: 401 })
    const { vaccine_name, date, next_due, notes } = ctx.body as any
    const r = db.run(
      'INSERT INTO immunizations (profile_id, vaccine_name, date, next_due, notes) VALUES (?, ?, ?, ?, ?)',
      ctx.params.id, vaccine_name, date, next_due || null, notes || ''
    )
    const row = db.query('SELECT * FROM immunizations WHERE id = ?').get(r.lastInsertRowid)
    return { data: row }
  })

  .get('/api/health', () => healthCheck())

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

  // ── Dashboard summary ──────────────────────────────────────
  .get('/api/dashboard', () => {
    const today = new Date().toISOString().split('T')[0]

    // Memos: total + 3 latest
    const allMemos = db.query('SELECT * FROM memos ORDER BY is_pinned DESC, created_at DESC').all() as any[]
    const memoSummary = { total: allMemos.length, latest: allMemos.slice(0, 3) }

    // Stock: total, hampir habis (qty <= min_threshold), total nilai (asumsikan qty*qty)
    const stockItems = db.query('SELECT * FROM stock_items ORDER BY category, name').all() as any[]
    const lowStock = stockItems.filter((s: any) => s.current_qty <= s.min_threshold)
    const stockSummary = {
      total: stockItems.length,
      low: lowStock.length,
      lowItems: lowStock.slice(0, 5),
      categories: [...new Set(stockItems.map((s: any) => s.category))].length,
    }

    // Checklists: count + completion progress
    const checklists = db.query('SELECT * FROM checklists ORDER BY sort_order ASC').all() as any[]
    const checklistSummary = checklists.map((cl: any) => {
      const items = db.query('SELECT id FROM checklist_items WHERE checklist_id = ?').all([cl.id]) as any[]
      const done = db.query(
        "SELECT COUNT(*) as c FROM checklist_completions WHERE item_id IN (SELECT id FROM checklist_items WHERE checklist_id = ?) AND completed_date = ?"
      ).get(cl.id, today) as any
      return { id: cl.id, title: cl.title, type: cl.type, total: items.length, completed: done?.c || 0 }
    })

    // Health: total profiles, latest weight
    const profiles = db.query('SELECT * FROM health_profiles').all() as any[]
    const healthSummary = profiles.map((p: any) => {
      const w = db.query(
        "SELECT value, date FROM health_measurements WHERE profile_id = ? AND type = 'weight' ORDER BY date DESC LIMIT 1"
      ).get(p.id) as any
      return { id: p.id, name: p.name, role: p.role, latestWeight: w || null }
    })

    // Events: next 7 days
    const nextWeek = new Date()
    nextWeek.setDate(nextWeek.getDate() + 7)
    const nextWeekStr = nextWeek.toISOString().split('T')[0]
    const upcomingEvents = db.query(
      'SELECT * FROM events WHERE event_date >= ? AND event_date <= ? ORDER BY event_date ASC, time ASC'
    ).all(today, nextWeekStr)

    // Backup status
    const { existsSync, readdirSync, statSync } = require('node:fs')
    const { join } = require('node:path')
    const backupDir = join(import.meta.dir, '..', 'data', 'backups')
    let lastBackup: string | null = null
    let backupCount = 0
    if (existsSync(backupDir)) {
      const files = readdirSync(backupDir).filter(f => f.startsWith('tomo_')).sort().reverse()
      backupCount = files.length
      if (files.length > 0) {
        const stat = statSync(join(backupDir, files[0]))
        lastBackup = files[0].replace('tomo_', '').replace('.db', '')
      }
    }

    return {
      memo: memoSummary,
      stock: stockSummary,
      checklist: checklistSummary,
      health: healthSummary,
      events: { total: upcomingEvents.length, upcoming: upcomingEvents.slice(0, 5) },
      backup: { lastBackup, count: backupCount },
      updated_at: new Date().toISOString(),
    }
  })

  // ── Backup Create (PIN-protected, on-disk) ──────────────
  .post('/api/backup/now', (ctx) => {
    if (!requirePin(ctx)) return new Response('Unauthorized', { status: 401 })
    const { existsSync, mkdirSync, cpSync, readdirSync, rmSync } = require('node:fs')
    const { join } = require('node:path')
    const DATA_DIR = join(import.meta.dir, '..', 'data')
    const BACKUP_DIR = join(DATA_DIR, 'backups')
    if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true })

    const now = new Date()
    const ts = now.getFullYear()
      + String(now.getMonth()+1).padStart(2,'0')
      + String(now.getDate()).padStart(2,'0')
      + String(now.getHours()).padStart(2,'0')
      + String(now.getMinutes()).padStart(2,'0')
      + String(now.getSeconds()).padStart(2,'0')
    const backupFile = join(BACKUP_DIR, `tomo_${ts}.db`)
    cpSync(join(DATA_DIR, 'tomo.db'), backupFile)

    // Rolling retention — keep 14 days
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000
    for (const f of readdirSync(BACKUP_DIR)) {
      if (!f.startsWith('tomo_') || !f.endsWith('.db')) continue
      const fp = join(BACKUP_DIR, f)
      const stat = require('node:fs').statSync(fp)
      if (stat.birthtimeMs < cutoff) rmSync(fp)
    }

    const files = readdirSync(BACKUP_DIR).filter(f => f.startsWith('tomo_')).length
    return { success: true, file: `backups/tomo_${ts}.db`, retention_days: 14, total_backups: files }
  })

  // ── Backup Export (no PIN — read-only) ───────────────────
  .get('/api/backup/export', () => {
    const tables = ['events','family_settings','checklists','checklist_items','checklist_completions','stock_items','memos','health_profiles','health_measurements','immunizations']
    const dump: Record<string, any[]> = {}
    for (const t of tables) {
      try {
        dump[t] = db.query(`SELECT * FROM ${t}`).all()
      } catch { dump[t] = [] }
    }
    return { exported_at: new Date().toISOString(), version: 1, data: dump }
  })

  // ── Backup Import (PIN-protected) ────────────────────────
  .post('/api/backup/import', (ctx) => {
    if (!requirePin(ctx)) return new Response('Unauthorized', { status: 401 })
    const { data } = ctx.body as any
    if (!data) return { success: false, error: 'No data provided' }

    const tables = ['events','family_settings','checklists','checklist_items','checklist_completions','stock_items','memos','health_profiles','health_measurements','immunizations']

    db.run('BEGIN TRANSACTION')
    try {
      for (const t of tables) {
        if (!data[t] || !Array.isArray(data[t])) continue
        db.run(`DELETE FROM ${t}`)
        if (data[t].length === 0) continue
        const cols = Object.keys(data[t][0])
        const placeholders = cols.map(() => '?').join(',')
        const stmt = db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${placeholders})`)
        for (const row of data[t]) {
          stmt.run(cols.map(c => row[c]))
        }
      }
      db.run('COMMIT')
      return { success: true, imported: true }
    } catch (e: any) {
      db.run('ROLLBACK')
      return { success: false, error: e.message }
    }
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
