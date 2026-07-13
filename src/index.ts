import { Elysia } from 'elysia'
import { cors } from '@elysiajs/cors'
import { join } from 'node:path'
import { createTables, seedDefaults } from './db/schema'
import { healthCheck } from './routes/health'

// Init DB
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
  .get('/*', async ({ path }) => {
    // Serve static files from public/
    const publicDir = join(import.meta.dir, '..', 'public')
    const filePath = path === '/' ? '/index.html' : path
    const file = Bun.file(join(publicDir, filePath))
    if (await file.exists()) {
      return new Response(file)
    }
    return new Response('Not Found', { status: 404 })
  })
  .listen(PORT, () => {
    console.log(`🏠 Tomo Family Hub running at http://localhost:${PORT}`)
  })

export type App = typeof app
