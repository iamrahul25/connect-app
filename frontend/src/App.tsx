import { useEffect, useMemo, useRef, useState } from 'react'

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

const WS_URL = 'ws://localhost:8080'

function App() {
  const socketRef = useRef<WebSocket | null>(null)
  const peerRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const remoteStreamRef = useRef<MediaStream | null>(null)
  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null)

  const [status, setStatus] = useState<Status>('disconnected')
  const [note, setNote] = useState('Connecting to lobby server...')
  const [isMuted, setIsMuted] = useState(false)
  const [isCameraOff, setIsCameraOff] = useState(false)
  const [hasStarted, setHasStarted] = useState(false)
  const [isCallConnected, setIsCallConnected] = useState(false)
  const [myUserId, setMyUserId] = useState('Assigning...')
  const [strangerUserId, setStrangerUserId] = useState('None')
  const [onlineUsers, setOnlineUsers] = useState(0)
  const [waitingUsers, setWaitingUsers] = useState(0)

  const isConnectingCall = status === 'matched' && !isCallConnected
  const isBusy = status === 'disconnected' || status === 'waiting' || isConnectingCall

  const stageText = useMemo(() => {
    if (status === 'disconnected') {
      return 'Connecting to lobby...'
    }

    if (!hasStarted) {
      return 'In lobby. Press Start to join queue.'
    }

    if (status === 'waiting') {
      return 'Queued in lobby. Finding a stranger...'
    }

    if (isConnectingCall) {
      return 'Stranger found. Connecting video...'
    }

    if (status === 'matched' && isCallConnected) {
      return 'Call is live.'
    }

    return 'Ready in lobby.'
  }, [hasStarted, isCallConnected, isConnectingCall, status])

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

  const ensureSocket = () => {
    const existing = socketRef.current
    if (existing && existing.readyState !== WebSocket.CLOSED) {
      return existing
    }

    const ws = new WebSocket(WS_URL)

    ws.onopen = () => {
      setStatus('idle')
      setNote('Connected. You are in the lobby.')
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
        setNote('Waiting in lobby queue for an available stranger.')
        return
      }

      if (payload.type === 'matched') {
        setStatus('matched')
        setIsCallConnected(false)
        setHasStarted(true)
        setStrangerUserId(payload.strangerId ?? 'Unknown')
        setNote(`Matched with ${payload.strangerId ?? 'a stranger'}. Establishing secure connection...`)
        await beginPeerConnection(Boolean(payload.initiator))
        return
      }

      if (payload.type === 'signal' && payload.data) {
        await handleSignal(payload.data)
        return
      }

      if (payload.type === 'idle') {
        closePeerConnection()
        setStatus('idle')
        setHasStarted(false)
        setIsCallConnected(false)
        setStrangerUserId('None')
        setNote('You left queue and returned to lobby.')
        return
      }

      if (payload.type === 'system') {
        closePeerConnection()
        setIsCallConnected(false)
        if (hasStarted) {
          setStatus('waiting')
          setStrangerUserId('Searching...')
        } else {
          setStatus('idle')
        }
        setNote(payload.text ?? 'Lobby update received.')
      }
    }

    ws.onclose = () => {
      closePeerConnection()
      setStatus('disconnected')
      setIsCallConnected(false)
      setStrangerUserId('None')
      setNote('Disconnected from lobby server. Refresh to reconnect.')
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
        setNote('Video call connected.')
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
      setNote('Joining lobby queue...')
      sendSocketMessage({ type: 'join' })
    } catch {
      setNote('Camera/mic permission denied. Enable permissions and try again.')
    }
  }

  const next = async () => {
    try {
      await ensureLocalMedia()
      setHasStarted(true)
      setIsCallConnected(false)
      closePeerConnection()
      setNote('Switching to the next stranger...')
      sendSocketMessage({ type: 'next' })
    } catch {
      setNote('Camera/mic permission is required.')
    }
  }

  const leave = () => {
    closePeerConnection()
    setHasStarted(false)
    setIsCallConnected(false)
    setStrangerUserId('None')
    setNote('Returned to lobby.')
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
      localStreamRef.current?.getTracks().forEach((track) => track.stop())
      localStreamRef.current = null
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    }
  }, [])

  useEffect(() => {
    attachLocalPreview()
  }, [isMuted, isCameraOff])

  return (
    <main className="ometv-app">
      <section className="shell">
        <aside className="lobby">
          <h1>OmeTV Lobby</h1>
          <p className="lobby-subtitle">Random video chat with auto-next matching.</p>

          <div className="stats">
            <div className="stat-card">
              <span>Total Online</span>
              <strong>{onlineUsers}</strong>
            </div>
            <div className="stat-card">
              <span>Waiting In Lobby</span>
              <strong>{waitingUsers}</strong>
            </div>
          </div>

          <div className="ids">
            <p>Your ID: {myUserId}</p>
            <p>Stranger ID: {strangerUserId}</p>
          </div>

          <p className="stage">{stageText}</p>
          <p className={`note ${isBusy ? 'loading' : ''}`}>{note}</p>

          <div className="main-actions">
            <button type="button" onClick={start}>
              Start
            </button>
            <button type="button" onClick={leave}>
              Back To Lobby
            </button>
          </div>
        </aside>

        <section className="call-area">
          <div className="video-grid">
            <article className="video-card">
              <h2>You</h2>
              <video ref={localVideoRef} autoPlay muted playsInline />
            </article>
            <article className="video-card">
              <h2>Stranger</h2>
              <video ref={remoteVideoRef} autoPlay playsInline />
            </article>
          </div>

          <div className="call-actions">
            <button type="button" onClick={next}>
              Next
            </button>
            <button type="button" onClick={toggleMute}>
              {isMuted ? 'Unmute' : 'Mute'}
            </button>
            <button type="button" onClick={toggleCamera}>
              {isCameraOff ? 'Camera On' : 'Camera Off'}
            </button>
          </div>
        </section>
      </section>
    </main>
  )
}

export default App
