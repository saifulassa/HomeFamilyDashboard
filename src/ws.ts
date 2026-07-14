import type { Server } from 'bun'

let bunServer: Server | null = null

export function setServer(s: Server) {
  bunServer = s
}

export function broadcast(msg: object, topic = 'events') {
  if (!bunServer) return
  bunServer.publish(topic, JSON.stringify(msg))
}
