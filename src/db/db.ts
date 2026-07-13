import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = join(import.meta.dir, '..', '..', 'data')
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

const DB_PATH = join(DATA_DIR, 'family.db')
const db = new Database(DB_PATH)

// Enable WAL mode for better concurrent reads
db.run('PRAGMA journal_mode = WAL')
db.run('PRAGMA foreign_keys = ON')

export default db
