import { useEffect, useRef, useState } from 'react'

type Status = 'disconnected' | 'idle' | 'waiting' | 'matched'

type SignalPayload = {
  description?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
}

type ServerPayload = {
  type?: string
  text?: string
  initiator?: boolean
  userId?: string
  strangerId?: string
  onlineUsers?: number
  waitingUsers?: number
  data?: SignalPayload
}

const WS_PORT = '8080'

function resolveWsUrl() {
  const envUrl = import.meta.env.VITE_WS_URL as string | undefined
  if (envUrl && envUrl.trim()) {
    return envUrl.trim()
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.hostname || 'localhost'
  return `${protocol}//${host}:${WS_PORT}`
}

function App() {
  const socketRef = useRef<WebSocket | null>(null)
  const peerRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const remoteStreamRef = useRef<MediaStream | null>(null)
  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null)
  const hasStartedRef = useRef(false)

  const [status, setStatus] = useState<Status>('disconnected')
  const [note, setNote] = useState('Connecting to lobby server...')
  const [isMuted, setIsMuted] = useState(false)
  const [isCameraOff, setIsCameraOff] = useState(false)
  const [hasStarted, setHasStarted] = useState(false)
  const [isCallConnected, setIsCallConnected] = useState(false)
  const [myUserId, setMyUserId] = useState('Assigning...')
  const [strangerUserId, setStrangerUserId] = useState('Waiting...')
  const [onlineUsers, setOnlineUsers] = useState(0)
  const [waitingUsers, setWaitingUsers] = useState(0)

  const isQueueing = status === 'waiting'
  const isConnecting = status === 'matched' && !isCallConnected

  useEffect(() => {
    hasStartedRef.current = hasStarted
  }, [hasStarted])

  const attachLocalPreview = () => {
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current
    }
  }

  const attachRemotePreview = () => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStreamRef.current
    }
  }

  const closePeerConnection = () => {
    if (peerRef.current) {
      peerRef.current.ontrack = null
      peerRef.current.onicecandidate = null
      peerRef.current.onconnectionstatechange = null
      peerRef.current.close()
      peerRef.current = null
    }

    remoteStreamRef.current = null
    attachRemotePreview()
  }

  const stopLocalMedia = () => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    localStreamRef.current = null
    setIsMuted(false)
    setIsCameraOff(false)
    attachLocalPreview()
  }

  const ensureSocket = () => {
    const existing = socketRef.current
    if (existing && existing.readyState < WebSocket.CLOSING) {
      return existing
    }

    const wsUrl = resolveWsUrl()
    const ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      setStatus('idle')
      setNote(`Connected to lobby (${wsUrl}). Press Start Calling.`)
    }

    ws.onmessage = async (event) => {
      let payload: ServerPayload

      try {
        payload = JSON.parse(event.data as string) as ServerPayload
      } catch {
        return
      }

      if (payload.type === 'welcome' && payload.userId) {
        setMyUserId(payload.userId)
        return
      }

      if (payload.type === 'lobby') {
        setOnlineUsers(payload.onlineUsers ?? 0)
        setWaitingUsers(payload.waitingUsers ?? 0)
        return
      }

      if (payload.type === 'waiting') {
        setStatus('waiting')
        setIsCallConnected(false)
        setStrangerUserId('Searching...')
        setNote('Waiting in lobby queue...')
        return
      }

      if (payload.type === 'matched') {
        setStatus('matched')
        setIsCallConnected(false)
        setHasStarted(true)
        setStrangerUserId(payload.strangerId ?? 'Unknown')
        setNote(`Matched with ${payload.strangerId ?? 'a stranger'}. Connecting video...`)
        await beginPeerConnection(Boolean(payload.initiator))
        return
      }

      if (payload.type === 'signal' && payload.data) {
        await handleSignal(payload.data)
        return
      }

      if (payload.type === 'idle') {
        closePeerConnection()
        stopLocalMedia()
        setStatus('idle')
        setHasStarted(false)
        setIsCallConnected(false)
        setStrangerUserId('Waiting...')
        setNote('Returned to lobby.')
        return
      }

      if (payload.type === 'system') {
        closePeerConnection()
        setIsCallConnected(false)
        if (hasStartedRef.current) {
          setStatus('waiting')
          setStrangerUserId('Searching...')
        } else {
          setStatus('idle')
          setStrangerUserId('Waiting...')
        }
        setNote(payload.text ?? 'Queue updated.')
      }
    }

    ws.onerror = () => {
      setStatus('disconnected')
      setNote(`Unable to connect to ${wsUrl}. Check backend and VITE_WS_URL.`)
    }

    ws.onclose = () => {
      closePeerConnection()
      stopLocalMedia()
      setStatus('disconnected')
      setHasStarted(false)
      setIsCallConnected(false)
      setStrangerUserId('Waiting...')
      setNote(`Server disconnected (${wsUrl}). Refresh to reconnect.`)
    }

    socketRef.current = ws
    return ws
  }

  const sendSocketMessage = (payload: Record<string, unknown>) => {
    const ws = ensureSocket()
    const data = JSON.stringify(payload)

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data)
      return
    }

    ws.addEventListener(
      'open',
      () => {
        ws.send(data)
      },
      { once: true },
    )
  }

  const ensureLocalMedia = async () => {
    if (localStreamRef.current) {
      return
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true,
    })

    localStreamRef.current = stream
    attachLocalPreview()
  }

  const beginPeerConnection = async (isInitiator: boolean) => {
    await ensureLocalMedia()
    closePeerConnection()

    const peer = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    })

    peerRef.current = peer
    remoteStreamRef.current = new MediaStream()
    attachRemotePreview()

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        peer.addTrack(track, localStreamRef.current as MediaStream)
      })
    }

    peer.ontrack = (event) => {
      const remoteStream = remoteStreamRef.current
      if (!remoteStream) {
        return
      }

      event.streams[0].getTracks().forEach((track) => remoteStream.addTrack(track))
      attachRemotePreview()
    }

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        sendSocketMessage({
          type: 'signal',
          data: { candidate: event.candidate.toJSON() },
        })
      }
    }

    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') {
        setIsCallConnected(true)
        setNote('Call connected.')
      }

      if (
        peer.connectionState === 'failed' ||
        peer.connectionState === 'disconnected' ||
        peer.connectionState === 'closed'
      ) {
        setIsCallConnected(false)
        closePeerConnection()
      }
    }

    if (isInitiator) {
      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      sendSocketMessage({
        type: 'signal',
        data: { description: offer },
      })
    }
  }

  const handleSignal = async (signal: SignalPayload) => {
    const peer = peerRef.current
    if (!peer) {
      return
    }

    if (signal.description) {
      await peer.setRemoteDescription(new RTCSessionDescription(signal.description))

      if (signal.description.type === 'offer') {
        const answer = await peer.createAnswer()
        await peer.setLocalDescription(answer)
        sendSocketMessage({
          type: 'signal',
          data: { description: answer },
        })
      }
    }

    if (signal.candidate) {
      try {
        await peer.addIceCandidate(new RTCIceCandidate(signal.candidate))
      } catch {
        return
      }
    }
  }

  const start = async () => {
    try {
      await ensureLocalMedia()
      setHasStarted(true)
      setStatus('waiting')
      setNote('Finding a stranger...')
      sendSocketMessage({ type: 'join' })
    } catch {
      setNote('Camera/mic permission denied.')
    }
  }

  const next = async () => {
    try {
      await ensureLocalMedia()
      setHasStarted(true)
      setStatus('waiting')
      setIsCallConnected(false)
      closePeerConnection()
      setStrangerUserId('Searching...')
      setNote('Skipping to next stranger...')
      sendSocketMessage({ type: 'next' })
    } catch {
      setNote('Camera/mic permission is required.')
    }
  }

  const backToLobby = () => {
    closePeerConnection()
    stopLocalMedia()
    setHasStarted(false)
    setStatus('idle')
    setIsCallConnected(false)
    setStrangerUserId('Waiting...')
    setNote('In lobby.')
    sendSocketMessage({ type: 'leave' })
  }

  const toggleMute = () => {
    const nextValue = !isMuted
    setIsMuted(nextValue)
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !nextValue
    })
  }

  const toggleCamera = () => {
    const nextValue = !isCameraOff
    setIsCameraOff(nextValue)
    localStreamRef.current?.getVideoTracks().forEach((track) => {
      track.enabled = !nextValue
    })
  }

  useEffect(() => {
    const ws = ensureSocket()

    return () => {
      closePeerConnection()
      stopLocalMedia()
      const state = ws.readyState
      ws.onopen = null
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
        ws.close()
      }
    }
  }, [])

  useEffect(() => {
    attachLocalPreview()
  }, [isMuted, isCameraOff])

  useEffect(() => {
    if (!hasStarted) {
      return
    }

    // When UI switches from lobby to call page, refs mount after local media may already exist.
    // Re-attach streams so local/remote videos become visible immediately.
    attachLocalPreview()
    attachRemotePreview()
  }, [hasStarted, status])

  if (!hasStarted) {
    return (
      <main className="lobby-page">
        <section className="lobby-card">
          <h1>Oolo TV</h1>
          <p className="lobby-subtitle">Connect with random people around the world</p>

          <div className="lobby-id-row">
            <span>Your ID: {myUserId}</span>
          </div>

          <div className="lobby-stats">
            <article className="stat online">
              <strong>{onlineUsers}</strong>
              <span>Online Users</span>
            </article>
            <article className="stat waiting">
              <strong>{waitingUsers}</strong>
              <span>Waiting In Lobby</span>
            </article>
          </div>

          <p className="lobby-note">{status === 'disconnected' ? 'Connecting to server...' : note}</p>

          <button type="button" onClick={start} disabled={status === 'disconnected'} className="start-btn">
            Start Calling
          </button>
        </section>
      </main>
    )
  }

  return (
    <main className="call-page">
      <header className="call-top">
        <p>Me: {myUserId}</p>
        <p>Stranger: {strangerUserId}</p>
        <p>Lobby Waiting: {waitingUsers}</p>
      </header>

      <section className="video-stage">
        <div className="video-panel">
          <video ref={remoteVideoRef} autoPlay playsInline />
          <span className="video-label">Stranger</span>
          {(isQueueing || isConnecting) && (
            <div className="stage-overlay">
              <h2>{isQueueing ? 'Finding Stranger...' : 'Connecting Call...'}</h2>
              <p>{note}</p>
            </div>
          )}
        </div>

        <div className="video-panel">
          <video ref={localVideoRef} autoPlay muted playsInline />
          <span className="video-label">You</span>
        </div>
      </section>

      <footer className="call-controls">
        <button type="button" onClick={toggleMute}>
          {isMuted ? 'Unmute' : 'Mute'}
        </button>
        <button type="button" onClick={toggleCamera}>
          {isCameraOff ? 'Camera On' : 'Camera Off'}
        </button>
        <button type="button" onClick={next}>
          Next
        </button>
        <button type="button" onClick={backToLobby} className="danger">
          Back To Lobby
        </button>
      </footer>
    </main>
  )
}

export default App
