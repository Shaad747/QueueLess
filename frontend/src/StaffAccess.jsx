import { useEffect, useState } from 'react'
import OperatorDesk from './OperatorDesk.jsx'
import './StaffAccess.css'

export default function StaffAccess({ user, requestJson, onQueueChange }) {
  if (!['operator', 'admin'].includes(user.role)) return null
  return <StaffCounters user={user} requestJson={requestJson} onQueueChange={onQueueChange} />
}

function StaffCounters({ user, requestJson, onQueueChange }) {
  const [counters, setCounters] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [version, setVersion] = useState(0)
  const [selected, setSelected] = useState(null)

  useEffect(() => {
    const controller = new AbortController()
    let timer
    async function load() {
      try {
        const data = await requestJson('/api/staff/counters', { signal: controller.signal })
        if (controller.signal.aborted) return
        setCounters(data.counters)
        setError('')
      } catch (err) {
        if (controller.signal.aborted) return
        setCounters([])
        setError(err.message)
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
          timer = setTimeout(load, 15000)
        }
      }
    }
    load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [requestJson, version])

  const chosen = counters.find((counter) => counter.id === selected)
  return (
    <section id="staff" className="staff-access" aria-labelledby="staff-heading">
      <div className="staff-access-heading">
        <div>
          <p className="eyebrow">Staff workspace</p>
          <h2 id="staff-heading">{user.role === 'admin' ? 'All campus counters' : 'Your assigned counters'}</h2>
          <p>Signed in as {user.name} · {user.role}</p>
        </div>
        <button type="button" className="primary-button" disabled={loading} onClick={() => {
          setLoading(true)
          setVersion((current) => current + 1)
        }}>Refresh counters</button>
      </div>
      {loading && <p role="status">Loading your counter access…</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
      {!loading && !error && counters.length === 0 && <p>No counters are assigned to your account yet. Ask your administrator for an assignment.</p>}
      {!error && counters.length > 0 && (
        <ul className="staff-counter-grid">
          {counters.map((counter) => (
            <li key={counter.id} className="staff-counter-card">
              <p className="eyebrow">Counter {counter.id}</p>
              <h3>{counter.serviceName}</h3>
              <p>{counter.name}</p>
              <p>{counter.active ? 'Counter enabled' : 'Counter disabled'} · {counter.serviceOpen ? 'Service open' : 'Service closed'}</p>
              <button type="button" className="primary-button" aria-pressed={selected === counter.id} onClick={() => setSelected(counter.id)}>
                {selected === counter.id ? 'Desk selected' : 'Open operator desk'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!error && chosen && <OperatorDesk key={`${user.id}:${chosen.id}`} userId={user.id} counter={chosen} requestJson={requestJson} onQueueChange={onQueueChange} />}
      {!chosen && counters.length > 0 && <p className="staff-access-note">Choose a counter to manage its visitors.</p>}
    </section>
  )
}
