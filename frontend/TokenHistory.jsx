import { useEffect, useRef, useState } from 'react'

const statusLabels = {
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'Absent',
}

function validatePage(data) {
  if (
    !Array.isArray(data.tokens) ||
    !(data.nextCursor === null || (
      Number.isSafeInteger(data.nextCursor) && data.nextCursor > 0
    ))
  ) {
    throw new Error('The server returned an unexpected history response.')
  }
  return data
}

function HistoryList({ requestJson }) {
  const [tokens, setTokens] = useState([])
  const [nextCursor, setNextCursor] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState(null)
  const [retryVersion, setRetryVersion] = useState(0)
  const controllerRef = useRef(null)
  const morePendingRef = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    controllerRef.current = controller

    async function loadHistory() {
      setIsLoading(true)
      setError('')

      try {
        const data = validatePage(await requestJson('/api/queues/history', {
          signal: controller.signal,
        }))

        if (!controller.signal.aborted) {
          setTokens(data.tokens)
          setNextCursor(data.nextCursor)
          setLastUpdated(new Date())
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err.message || 'Could not load your history.')
        }
      } finally {
        if (!controller.signal.aborted) setIsLoading(false)
      }
    }

    loadHistory()
    return () => controller.abort()
  }, [requestJson, retryVersion])

  async function loadOlder() {
    if (nextCursor === null || morePendingRef.current || isLoading) return
    const controller = controllerRef.current
    if (!controller || controller.signal.aborted) return

    morePendingRef.current = true
    setIsLoadingMore(true)
    setError('')

    try {
      const data = validatePage(await requestJson(
        `/api/queues/history?before=${encodeURIComponent(nextCursor)}`,
        { signal: controller.signal }
      ))

      if (!controller.signal.aborted) {
        setTokens((current) => {
          const seenIds = new Set(current.map((token) => token.id))
          return [...current, ...data.tokens.filter((token) => !seenIds.has(token.id))]
        })
        setNextCursor(data.nextCursor)
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err.message || 'Could not load older tokens.')
      }
    } finally {
      morePendingRef.current = false
      if (!controller.signal.aborted) setIsLoadingMore(false)
    }
  }

  return (
    <>
      <div className="history-toolbar">
        <p className="history-note">
          {lastUpdated
            ? `Last refreshed: ${lastUpdated.toLocaleTimeString()} · Local time`
            : 'Your finished tokens will appear here.'}
        </p>
        <button
          className="text-button"
          type="button"
          disabled={isLoading || isLoadingMore}
          onClick={() => setRetryVersion((value) => value + 1)}
        >
          {isLoading ? 'Loading…' : 'Refresh history'}
        </button>
      </div>

      {isLoading && <p role="status">Loading token history…</p>}
      {error && <p className="error-message" role="alert">{error}</p>}

      {!isLoading && !error && tokens.length === 0 && (
        <p className="history-note">
          No finished tokens yet. Cancelled, completed, and absent tokens will
          appear here. Active tokens stay under My tokens.
        </p>
      )}

      {!isLoading && tokens.length > 0 && (
        <ul className="history-list" aria-label="Your finished tokens">
          {tokens.map((token) => (
            <li className="history-entry" key={token.id}>
              <div>
                <h3>{token.serviceName} · <strong>{token.number}</strong></h3>
                <p>Queue date: {token.serviceDate}</p>
                <p>
                  Issued: <time dateTime={token.issuedAt}>
                    {new Date(token.issuedAt).toLocaleString()}
                  </time>{' · '}Local time
                </p>
              </div>
              <span className={`history-status history-status-${token.status}`}>
                {statusLabels[token.status] || token.status}
              </span>
            </li>
          ))}
        </ul>
      )}

      {!isLoading && nextCursor !== null && (
        <button
          className="text-button"
          type="button"
          disabled={isLoadingMore}
          onClick={loadOlder}
        >
          {isLoadingMore ? 'Loading older tokens…' : 'Load older tokens'}
        </button>
      )}
    </>
  )
}

export default function TokenHistory({ user, refreshVersion, requestJson, isBusy }) {
  return (
    <section id="history" className="history-section" aria-labelledby="history-title">
      <p className="eyebrow">Your past visits</p>
      <h2 id="history-title">Token history</h2>
      <p className="history-note">
        Your finished tokens, newest first. History refreshes after queue actions
        and when you select Refresh history.
      </p>

      {!user ? (
        <p className="history-note"><a href="#account">Sign in to view your history.</a></p>
      ) : isBusy ? (
        <p role="status">Updating your queue information…</p>
      ) : (
        <HistoryList key={`${user.id}:${refreshVersion}`} requestJson={requestJson} />
      )}
    </section>
  )
}
