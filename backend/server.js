import { WebSocketServer } from 'ws'
import 'dotenv/config'

const PORT = Number(process.env.PORT ?? 8080)
const wss = new WebSocketServer({ port: PORT })

const waitingQueue = []
const peers = new Map()
const clientIds = new Map()
let nextUserId = 1

function safeSend(ws, payload) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload))
  }
}

function removeFromQueue(ws) {
  const index = waitingQueue.indexOf(ws)
  if (index !== -1) {
    waitingQueue.splice(index, 1)
  }
}

function cleanupQueue() {
  for (let i = waitingQueue.length - 1; i >= 0; i -= 1) {
    if (waitingQueue[i].readyState !== waitingQueue[i].OPEN) {
      waitingQueue.splice(i, 1)
    }
  }
}

function getLobbyStats() {
  cleanupQueue()
  return {
    onlineUsers: clientIds.size,
    waitingUsers: waitingQueue.length,
  }
}

function broadcastLobbyStats() {
  const stats = getLobbyStats()
  for (const client of wss.clients) {
    safeSend(client, { type: 'lobby', ...stats })
  }
}

function detachClient(ws, options = {}) {
  const { notifyPeer = false, autoRequeuePeer = false, message = 'Stranger disconnected.' } = options

  removeFromQueue(ws)

  const partner = peers.get(ws)
  if (!partner) {
    broadcastLobbyStats()
    return
  }

  peers.delete(ws)
  peers.delete(partner)

  if (notifyPeer && partner.readyState === partner.OPEN) {
    safeSend(partner, {
      type: 'system',
      text: message,
    })

    if (autoRequeuePeer) {
      enqueueOrMatch(partner)
    }
  }

  broadcastLobbyStats()
}

function tryMatchQueue() {
  cleanupQueue()

  while (waitingQueue.length >= 2) {
    const first = waitingQueue.shift()
    const second = waitingQueue.shift()

    if (!first || !second) {
      break
    }

    if (first.readyState !== first.OPEN || second.readyState !== second.OPEN || first === second) {
      if (first.readyState === first.OPEN) {
        waitingQueue.unshift(first)
      }
      if (second.readyState === second.OPEN) {
        waitingQueue.unshift(second)
      }
      break
    }

    peers.set(first, second)
    peers.set(second, first)

    safeSend(first, {
      type: 'matched',
      initiator: true,
      strangerId: clientIds.get(second),
    })
    safeSend(second, {
      type: 'matched',
      initiator: false,
      strangerId: clientIds.get(first),
    })
  }
}

function enqueueOrMatch(ws) {
  removeFromQueue(ws)
  waitingQueue.push(ws)

  safeSend(ws, { type: 'waiting' })
  tryMatchQueue()
  broadcastLobbyStats()
}

wss.on('connection', (ws) => {
  const userId = `U${String(nextUserId).padStart(4, '0')}`
  nextUserId += 1
  clientIds.set(ws, userId)

  safeSend(ws, { type: 'welcome', userId })
  safeSend(ws, { type: 'system', text: 'Connected to server. Click "Start".' })
  safeSend(ws, { type: 'lobby', ...getLobbyStats() })
  broadcastLobbyStats()

  ws.on('message', (rawData) => {
    let message

    try {
      message = JSON.parse(rawData.toString())
    } catch {
      return
    }

    switch (message.type) {
      case 'join': {
        detachClient(ws)
        enqueueOrMatch(ws)
        break
      }
      case 'next': {
        detachClient(ws, {
          notifyPeer: true,
          autoRequeuePeer: true,
          message: 'Stranger skipped. Auto-finding a new stranger...',
        })
        enqueueOrMatch(ws)
        break
      }
      case 'leave': {
        detachClient(ws, {
          notifyPeer: true,
          autoRequeuePeer: true,
          message: 'Stranger left. Auto-finding a new stranger...',
        })
        safeSend(ws, { type: 'idle' })
        break
      }
      case 'message': {
        const partner = peers.get(ws)
        if (!partner || typeof message.text !== 'string') {
          return
        }

        const text = message.text.trim()
        if (!text) {
          return
        }

        safeSend(partner, { type: 'message', text })
        break
      }
      case 'signal': {
        const partner = peers.get(ws)
        if (!partner || typeof message.data !== 'object' || message.data === null) {
          return
        }

        safeSend(partner, { type: 'signal', data: message.data })
        break
      }
      default:
        break
    }
  })

  ws.on('close', () => {
    detachClient(ws, {
      notifyPeer: true,
      autoRequeuePeer: true,
      message: 'Stranger disconnected. Auto-finding a new stranger...',
    })
    clientIds.delete(ws)
    removeFromQueue(ws)
    broadcastLobbyStats()
  })
})

console.log(`Omegle clone backend running on ws://localhost:${PORT}`)
