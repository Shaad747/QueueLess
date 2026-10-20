import { useEffect, useRef, useState } from 'react'
import './OperatorDesk.css'

const labels = { 'call-next': 'Call next visitor', start: 'Start service', complete: 'Complete visit', 'no-show': 'Mark absent' }
function restoreRequest(key) {
  try {
    const item = JSON.parse(sessionStorage.getItem(key))
    return item && Object.hasOwn(labels, item.action) && typeof item.requestId === 'string' ? item : null
  } catch { return null }
}

export default function OperatorDesk({ userId, counter, requestJson, onQueueChange }) {
  const storageKey = `queueless:operator:${userId}:${counter.id}`
  const [desk, setDesk] = useState(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState(() => restoreRequest(storageKey))
  const [version, setVersion] = useState(0)
  const [confirmAbsent, setConfirmAbsent] = useState(null)
  const inFlight = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (busy) return
    const controller = new AbortController()
    let timer
    async function load() {
      try {
        const data = await requestJson(`/api/staff/counters/${counter.id}/desk`, { signal: controller.signal })
        if (controller.signal.aborted) return
        setDesk(data)
        setError('')
      } catch (err) {
        if (controller.signal.aborted) return
        setDesk(null)
        setError(err.message)
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(load, 5000)
      }
    }
    load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [busy, counter.id, requestJson, version])

  function remember(item) {
    setPending(item)
    try {
      if (item) sessionStorage.setItem(storageKey, JSON.stringify(item))
      else sessionStorage.removeItem(storageKey)
    } catch { /* The in-memory request still protects retries in this tab. */ }
  }

  async function act(action, tokenId = null) {
    if (inFlight.current) return
    const operation = pending || { action, tokenId, requestId: crypto.randomUUID() }
    inFlight.current = true
    remember(operation)
    setBusy(true)
    setError('')
    setMessage('')
    setConfirmAbsent(null)
    try {
      const result = await requestJson(`/api/staff/counters/${counter.id}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-QueueLess-Action': 'operator' },
        body: JSON.stringify(operation),
      })
      if (mounted.current) {
        remember(null)
        setMessage(result.message)
        onQueueChange?.()
      } else {
        try { sessionStorage.removeItem(storageKey) } catch { /* Storage may be unavailable. */ }
      }
    } catch (err) {
      if (!mounted.current) return
      // A lost response or server failure might follow a committed action.
      // Keep exactly the same request ID so Retry cannot call another visitor.
      if (err.status >= 400 && err.status < 500) remember(null)
      setError(err.message)
    } finally {
      inFlight.current = false
      if (mounted.current) {
        setBusy(false)
        setDesk(null)
        setVersion((current) => current + 1)
      }
    }
  }

  const token = desk?.currentToken
  const locked = busy || !!pending
  const canCall = desk && !token && desk.counter.active && desk.counter.serviceOpen && desk.waitingCount > 0
  return (
    <div className="operator-desk" aria-labelledby="operator-heading">
      <div className="operator-desk-heading">
        <div>
          <p className="eyebrow">Operator desk</p>
          <h3 id="operator-heading">{counter.serviceName} · {counter.name}</h3>
        </div>
        <button type="button" className="operator-secondary" disabled={busy} onClick={() => setVersion((current) => current + 1)}>Refresh desk</button>
      </div>
      {message && <p className="operator-success" role="status">{message}</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
      {pending && !busy && <div className="operator-retry" role="status">
        <p>Confirm the last action before continuing: {labels[pending.action]}.</p>
        <button type="button" className="primary-button" onClick={() => act(pending.action, pending.tokenId)}>Retry safely</button>
      </div>}
      {busy && <p role="status">Saving action…</p>}
      {!desk && !error && !busy && <p role="status">Loading the desk…</p>}
      {desk && <>
        {(!desk.counter.active || !desk.counter.serviceOpen) && <p className="operator-retry">This counter or service is closed. Finish any current visit before leaving the desk.</p>}
        <div className="operator-current">
          <p className="eyebrow">Current visitor</p>
          {token ? <>
            <strong className="operator-number">{token.number}</strong>
            <p>{token.visitorName} · {token.status === 'CALLED' ? 'Called — waiting to arrive' : 'Service in progress'}</p>
            <p>Queue date: {token.serviceDate}</p>
            <div className="operator-actions">
              {token.status === 'CALLED' && <>
                <button type="button" className="primary-button" disabled={locked} onClick={() => act('start', token.id)}>Start service</button>
                <button type="button" className="operator-secondary" disabled={locked} onClick={() => setConfirmAbsent(token.id)}>Mark absent</button>
              </>}
              {token.status === 'SERVING' && <button type="button" className="primary-button" disabled={locked} onClick={() => act('complete', token.id)}>Complete visit</button>}
            </div>
            {confirmAbsent === token.id && !locked && <div className="operator-retry">
              <p>Confirm that {token.number} has not arrived. This ends their turn.</p>
              <div className="operator-actions">
                <button type="button" className="operator-danger" onClick={() => act('no-show', token.id)}>Confirm absent</button>
                <button type="button" className="operator-secondary" onClick={() => setConfirmAbsent(null)}>Keep waiting</button>
              </div>
            </div>}
          </> : <>
            <h4>Ready for the next visitor</h4>
            <p>{desk.waitingCount} waiting in this service today.</p>
            <button type="button" className="primary-button" disabled={locked || !canCall} onClick={() => act('call-next')}>Call next visitor</button>
          </>}
        </div>
        <div className="operator-waiting">
          <h4>Waiting queue · {desk.waitingCount}</h4>
          {desk.waiting.length ? <ol>{desk.waiting.map((item) => <li key={item.id}><strong>{item.number}</strong><span>Joined {new Date(item.issuedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></li>)}</ol> : <p>No visitors waiting today.</p>}
          {desk.waitingCount > 10 && <p>Showing the first 10 visitors.</p>}
        </div>
        <p className="staff-access-note">Refreshes every 5 seconds. Visitors are called in queue order.</p>
      </>}
    </div>
  )
}
