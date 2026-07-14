import db from './db'

export function createTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      event_date TEXT NOT NULL,
      time TEXT DEFAULT '',
      color TEXT DEFAULT '#1f6feb',
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS family_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS checklists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('daily', 'weekly', 'monthly')),
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS checklist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      checklist_id INTEGER NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('daily', 'weekly', 'monthly')),
      day_of_week INTEGER,
      day_of_month INTEGER,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS checklist_completions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
      completed_by TEXT NOT NULL,
      completed_date TEXT NOT NULL,
      completed_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS stock_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Lainnya',
      current_qty REAL NOT NULL DEFAULT 0,
      min_threshold REAL NOT NULL DEFAULT 1,
      unit TEXT DEFAULT 'pcs',
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS memos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      color TEXT DEFAULT '#FEF3C7',
      is_pinned INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS health_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('adult', 'child')),
      birth_date TEXT,
      gender TEXT CHECK(gender IN ('L', 'P')),
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS health_measurements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES health_profiles(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('bp', 'weight', 'height', 'temperature', 'glucose', 'other')),
      value REAL,
      systolic INTEGER,
      diastolic INTEGER,
      date TEXT NOT NULL DEFAULT (date('now', 'localtime')),
      notes TEXT DEFAULT ''
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS immunizations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES health_profiles(id) ON DELETE CASCADE,
      vaccine_name TEXT NOT NULL,
      date TEXT NOT NULL,
      next_due TEXT,
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `)

  // Indexes
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date)',
    'CREATE INDEX IF NOT EXISTS idx_checklist_items_checklist ON checklist_items(checklist_id)',
    'CREATE INDEX IF NOT EXISTS idx_checklist_completions_item ON checklist_completions(item_id)',
    'CREATE INDEX IF NOT EXISTS idx_checklist_completions_date ON checklist_completions(completed_date)',
    'CREATE INDEX IF NOT EXISTS idx_stock_category ON stock_items(category)',
    'CREATE INDEX IF NOT EXISTS idx_health_measurements_profile ON health_measurements(profile_id)',
    'CREATE INDEX IF NOT EXISTS idx_immunizations_profile ON immunizations(profile_id)',
    'CREATE INDEX IF NOT EXISTS idx_memos_pinned ON memos(is_pinned)',
  ]

  for (const sql of indexes) {
    db.run(sql)
  }

  // Migration: add columns for existing DBs
  const cols = db.query("PRAGMA table_info('events')").all() as { name: string }[]
  const hasTime = cols.some((c) => c.name === 'time')
  if (!hasTime) {
    db.run("ALTER TABLE events ADD COLUMN time TEXT DEFAULT ''")
    db.run("ALTER TABLE events ADD COLUMN color TEXT DEFAULT '#1f6feb'")
  }
}

export function seedDefaults() {
  const count = db.query('SELECT COUNT(*) as c FROM family_settings').get() as { c: number }
  if (count.c > 0) return

  db.run(`
    INSERT INTO family_settings (key, value) VALUES
      ('pin_hash', ''),
      ('pin_enabled', 'false'),
      ('head_birthday', ''),
      ('head_birthday_name', ''),
      ('anniversary_date', ''),
      ('anniversary_label', ''),
      ('default_theme', 'auto')
  `)
}

// Seed checklist groups
export function seedChecklists() {
  const clCount = db.query('SELECT COUNT(*) as c FROM checklists').get() as { c: number }
  if (clCount.c > 0) return

  db.run(`INSERT INTO checklists (id, title, type, sort_order) VALUES
    (1, 'Pekerjaan Rumah', 'daily', 1),
    (2, 'Tugas Anak', 'daily', 2),
    (3, 'Kebersihan Mingguan', 'weekly', 3),
    (4, 'Tagihan Bulanan', 'monthly', 4)
  `)
  db.run(`INSERT INTO checklist_items (checklist_id, label, type, sort_order) VALUES
    (1, 'Sapu rumah', 'daily', 1),
    (1, 'Cuci piring', 'daily', 2),
    (1, 'Buang sampah', 'daily', 3),
    (1, 'Merapikan tempat tidur', 'daily', 4),
    (2, 'PR Matematika', 'daily', 1),
    (2, 'Baca buku 30 menit', 'daily', 2),
    (2, 'Hafalan surat pendek', 'daily', 3),
    (3, 'Menyapu halaman', 'weekly', 1),
    (3, 'Menyiram tanaman', 'weekly', 2),
    (3, 'Membersihkan kaca jendela', 'weekly', 3),
    (4, 'Bayar listrik', 'monthly', 1),
    (4, 'Bayar air PDAM', 'monthly', 2),
    (4, 'Bayar internet', 'monthly', 3)
  `)
}

// Seed stock items
export function seedStock() {
  const count = db.query('SELECT COUNT(*) as c FROM stock_items').get() as { c: number }
  if (count.c > 0) return

  db.run(`INSERT INTO stock_items (name, category, current_qty, min_threshold, unit) VALUES
    ('Beras', 'Makanan', 5, 2, 'kg'),
    ('Minyak Goreng', 'Makanan', 3, 1, 'L'),
    ('Gula', 'Makanan', 2, 1, 'kg'),
    ('Telur', 'Makanan', 12, 6, 'butir'),
    ('Sabun Mandi', 'Sanitasi', 3, 2, 'pcs'),
    ('Shampoo', 'Sanitasi', 2, 1, 'botol'),
    ('Pasta Gigi', 'Sanitasi', 2, 1, 'pcs'),
    ('Sabun Cuci Piring', 'Sanitasi', 1, 1, 'pcs'),
    ('Tissue', 'Lainnya', 4, 2, 'pak'),
    ('Kantong Sampah', 'Lainnya', 10, 5, 'lembar')
  `)
}

// Seed memos
export function seedMemos() {
  const count = db.query('SELECT COUNT(*) as c FROM memos').get() as { c: number }
  if (count.c > 0) return

  db.run(`INSERT INTO memos (content, color, is_pinned) VALUES
    ('Jangan lupa bayar listrik sebelum tanggal 20!', '#FEF3C7', 0),
    ('Rencana liburan akhir tahun: ke Jogja 🏔️', '#DCFCE7', 0),
    ('Resep baru: Nasi goreng kencur — coba weekend ini', '#DBEAFE', 1),
    ('PIN WiFi: 12345678', '#FEE2E2', 1)
  `)
}
