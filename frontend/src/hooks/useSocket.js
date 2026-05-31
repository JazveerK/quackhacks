import { useEffect, useRef, useState, useCallback } from 'react'

export default function useSocket() {
  const wsRef = useRef(null)
  const [connected, setConnected] = useState(false)
  const [state, setState] = useState(null)
  const [frame, setFrame] = useState(null)
  const [summary, setSummary] = useState(null)
  const [aiDebrief, setAiDebrief] = useState(null)
  const [profile, setProfile] = useState(null)
  // Voice-agent reply. Wrapped with a monotonic seq so the same spoken text
  // twice in a row still triggers a fresh effect (play TTS, surface report).
  const [agentReply, setAgentReply] = useState(null)
  const seqRef = useRef(0)

  useEffect(() => {
    let reconnectMs = 500
    let unmounted = false

    function connect() {
      if (unmounted) return
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${location.host}/ws`)
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        reconnectMs = 500
      }

      ws.onclose = () => {
        setConnected(false)
        if (!unmounted) setTimeout(connect, reconnectMs)
        reconnectMs = Math.min(reconnectMs * 2, 4000)
      }

      ws.onmessage = (ev) => {
        let msg
        try { msg = JSON.parse(ev.data) } catch { return }
        switch (msg.type) {
          case 'frame':
            setFrame(msg.jpeg)
            break
          case 'state':
            setState(msg.state)
            break
          case 'set_end':
            setSummary(msg.summary)
            break
          case 'ai_debrief':
            setAiDebrief(msg)
            break
          case 'profile':
            setProfile(msg.profile)
            break
          case 'agent_reply':
            seqRef.current += 1
            setAgentReply({ ...msg, seq: seqRef.current })
            break
        }
      }
    }

    connect()
    return () => {
      unmounted = true
      wsRef.current?.close()
    }
  }, [])

  const send = useCallback((obj) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj))
    }
  }, [])

  return {
    connected, state, frame, summary, aiDebrief, profile, agentReply,
    send, setSummary, setAgentReply,
  }
}
