import type { Server } from 'bun'

let bunServer: Server | null = null

export function setServer(s: Server) {
  bunServer = s
}

export function broadcast(msg: object) {
  if (!bunServer) return
  bunServer.publish('events', JSON.stringify(msg))
}
