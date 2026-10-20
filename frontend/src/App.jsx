import { useEffect, useRef, useState } from 'react'
import './App.css'
import TokenHistory from './TokenHistory.jsx'
import StaffAccess from './StaffAccess.jsx'
import AdminPanel from './AdminPanel.jsx'
import AppFeatures from './AppFeatures.jsx'

// Send a request and turn backend errors into readable messages.
async function requestJson(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase()
  const headers = new Headers(options.headers)
  if (!['GET','HEAD'].includes(method)) {
    headers.set('X-QueueLess-Request','1')
    headers.set('Content-Type','application/json')
    if (!navigator.onLine) throw new Error('You are offline. Reconnect before making changes.')
  }
  const response = await fetch(url, {
    ...options,
    headers,
    cache: 'no-store',
  })

  const data = await response.json().catch(() => null)

  if (!response.ok) {
    const error = new Error(
      data?.message || `Request failed (${response.status}). Please try again.`
    )
    error.status = response.status
    throw error
  }

  if (!data) {
    throw new Error('The server returned an unexpected response.')
  }

  return data
}

function tokenWaitLabel(token, services) {
  const service = services.find((item) => item.id === token.serviceId)
  if (!service || !service.isOpen || service.activeCounters < 1 || service.sampleCount < 3 || service.meanServiceMinutes == null) return 'Estimated wait: not enough data.'
  const minutes = Math.ceil(token.peopleAhead * service.meanServiceMinutes / service.activeCounters)
  return `Estimated wait: about ${minutes} min. This is an estimate, not an appointment.`
}

function App() {
  const tokenSnapshot = useRef(null)
  const [services, setServices] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  const [user, setUser] = useState(null)
  const [isCheckingLogin, setIsCheckingLogin] = useState(true)
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [isRegistering, setIsRegistering] = useState(false)
  const [isCreatingAccount, setIsCreatingAccount] = useState(false)
  const [password, setPassword] = useState('')
  const [loginMessage, setLoginMessage] = useState('')
  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const [isLoggingOut, setIsLoggingOut] = useState(false)

  const [myTokens, setMyTokens] = useState([])
  const [queueError, setQueueError] = useState('')
  const [tokenLoadError, setTokenLoadError] = useState('')
  const [joiningServiceId, setJoiningServiceId] = useState(null)
  const [lastTokenUpdate, setLastTokenUpdate] = useState(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [cancellingTokenId, setCancellingTokenId] = useState(null)
  const [queueMessage, setQueueMessage] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    let timeoutId

    async function loadServices() {
      try {
        const data = await requestJson('/api/services', {
          signal: controller.signal,
        })

        if (!Array.isArray(data)) {
          throw new Error('The services response was not in the expected format.')
        }

        if (!controller.signal.aborted) {
          setServices(data)
          setError('')
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(
            `${err.message} Displayed information may be out of date.`
          )
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false)
          timeoutId = window.setTimeout(loadServices, 5000)
        }
      }
    }

    loadServices()

    return () => {
      controller.abort()
      window.clearTimeout(timeoutId)
    }
  }, [refreshVersion])

  // Check whether the browser already has a signed-in session.
  useEffect(() => {
    const controller = new AbortController()

    async function checkLogin() {
      try {
        const data = await requestJson('/api/auth/me', {
          signal: controller.signal,
        })

        if (!controller.signal.aborted) {
          setUser(data.user || null)
        }
      } catch (err) {
        if (!controller.signal.aborted && err.status !== 401) {
          setLoginMessage(
            'Could not check your session. You can try signing in below.'
          )
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsCheckingLogin(false)
        }
      }
    }

    checkLogin()

    return () => controller.abort()
  }, [])

  // Restore the signed-in visitor's token and refresh it every five seconds.
  useEffect(() => {
    if (!user || joiningServiceId !== null || cancellingTokenId !== null || isLoggingOut) return

    const controller = new AbortController()
    let timeoutId
    let sessionExpired = false

    async function loadMyToken() {
      try {
        const data = await requestJson('/api/queues/my-tokens', {
          signal: controller.signal,
        })

        if (!Array.isArray(data.tokens)) {
          throw new Error('Unexpected token response.')
        }

        if (!controller.signal.aborted) {
          const snapshot = `${user.id}:${JSON.stringify(data.tokens.map((t) => [t.id,t.status]))}`
          if (tokenSnapshot.current !== null && tokenSnapshot.current !== snapshot) setRefreshVersion((v) => v + 1)
          tokenSnapshot.current = snapshot
          setMyTokens(data.tokens)
          setLastTokenUpdate(new Date())
          setTokenLoadError('')
        }
      } catch (err) {
        if (controller.signal.aborted) return

        if (err.status === 401) {
          sessionExpired = true
          setUser(null)
          setMyTokens([])
          setLastTokenUpdate(null)
          setTokenLoadError('')
          setQueueError('')
      setQueueMessage('')
          setLoginMessage('Your session has expired. Please sign in again.')
        } else {
          setTokenLoadError(
            'Could not refresh your token. Displayed information may be out of date. Retrying shortly.'
          )
        }
      } finally {
        if (!controller.signal.aborted && !sessionExpired) {
          timeoutId = window.setTimeout(loadMyToken, 5000)
        }
      }
    }

    loadMyToken()

    return () => {
      controller.abort()
      window.clearTimeout(timeoutId)
    }
  }, [user, refreshVersion, joiningServiceId, cancellingTokenId, isLoggingOut])

  async function handleLogin(event) {
    event.preventDefault()

    if (isLoggingIn) return

    setIsLoggingIn(true)
    setLoginMessage('')

    try {
      const data = await requestJson('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: email.trim(),
          password,
        }),
      })

      setMyTokens([])
      setLastTokenUpdate(null)
      setQueueError('')
      setQueueMessage('')
      setTokenLoadError('')
      setUser(data.user)
      setIsRegistering(false)
      setPassword('')
      setLoginMessage(`Welcome, ${data.user.name}. You are signed in.`)
    } catch (err) {
      setLoginMessage(err.message)
    } finally {
      setIsLoggingIn(false)
    }
  }

  async function handleRegister(event) {
    event.preventDefault()
    if (isCreatingAccount || isLoggingIn) return

    setIsCreatingAccount(true)
    setLoginMessage('')

    try {
      const registration = await requestJson('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: fullName.trim(),
          email: email.trim(),
          password,
        }),
      })

      // The registration route creates an account but does not create a session.
      // Sign in immediately so the new visitor can use the queue.
      try {
        const login = await requestJson('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim(), password }),
        })

        setMyTokens([])
        setLastTokenUpdate(null)
        setQueueError('')
        setQueueMessage('')
        setTokenLoadError('')
        setUser(login.user)
        setIsRegistering(false)
        setPassword('')
        setLoginMessage(`Account created. Welcome, ${login.user.name}!`)
      } catch {
        setIsRegistering(false)
        setPassword('')
        setLoginMessage(
          `${registration.message || 'Account created successfully.'} Please sign in with your new account.`
        )
      }
    } catch (err) {
      setLoginMessage(err.message || 'Could not create your account.')
    } finally {
      setIsCreatingAccount(false)
    }
  }

  async function handleLogout() {
    if (isLoggingOut || joiningServiceId !== null || cancellingTokenId !== null) return

    setIsLoggingOut(true)
    setLoginMessage('')

    try {
      await requestJson('/api/auth/logout', {
        method: 'POST',
      })

      setUser(null)
      setIsRegistering(false)
      setMyTokens([])
      setLastTokenUpdate(null)
      setQueueError('')
      setQueueMessage('')
      setTokenLoadError('')
      setPassword('')
      setLoginMessage('You are signed out.')
    } catch (err) {
      setLoginMessage(err.message)
    } finally {
      setIsLoggingOut(false)
    }
  }

  async function cancelToken(token) {
    if (cancellingTokenId !== null || joiningServiceId !== null || isLoggingOut) return

    if (!user) {
      setLoginMessage('Please sign in before cancelling a token.')
      return
    }

    setCancellingTokenId(token.id)
    setQueueError('')
    setQueueMessage('')

    try {
      await requestJson(`/api/tokens/${token.id}/cancel`, {
        method: 'POST',
      })

      setMyTokens((current) => current.filter((item) => item.id !== token.id))
      setQueueMessage(
        `${token.number} for ${token.serviceName} was cancelled. ` +
        'Join again to receive a new place at the end of the queue.'
      )
    } catch (err) {
      setQueueError(err.message)

      if (err.status === 401) {
        setUser(null)
        setMyTokens([])
        setLastTokenUpdate(null)
        setTokenLoadError('')
        setQueueMessage('')
        setLoginMessage('Your session has expired. Please sign in again.')
      }
    } finally {
      // Reload even after a network error: cancellation may have reached the server.
      setRefreshVersion((value) => value + 1)
      setCancellingTokenId(null)
    }
  }

  async function joinQueue(service) {
    if (joiningServiceId !== null || cancellingTokenId !== null || isLoggingOut) return

    setQueueError('')
      setQueueMessage('')

    if (!user) {
      setLoginMessage('Please sign in before joining a queue.')
      document.getElementById('account')?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
      return
    }

    setJoiningServiceId(service.id)

    try {
      const data = await requestJson(
        `/api/queues/${service.id}/join`,
        { method: 'POST' }
      )

      setMyTokens((current) => [
        data.token,
        ...current.filter((token) => token.id !== data.token.id),
      ])
      setLastTokenUpdate(new Date())
      setTokenLoadError('')
      setRefreshVersion((value) => value + 1)

      document.getElementById('my-token')?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
    } catch (err) {
      if (err.status === 401) {
        setUser(null)
        setMyTokens([])
        setLastTokenUpdate(null)
        setTokenLoadError('')
        setLoginMessage('Your session has expired. Please sign in again.')
      }

      // Reload current information if the queue changed or a token exists.
      if (err.status === 409) {
        setRefreshVersion((value) => value + 1)
      }

      setQueueError(err.message)

      document.getElementById('my-token')?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
    } finally {
      setJoiningServiceId(null)
    }
  }

  return (
    <>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Shaad747Queueless home">
          <span className="brand-mark">Q</span>
          <span>Shaad747Queueless</span>
        </a>

        <nav className="main-nav" aria-label="Main navigation">
          <a href="#services">Services</a>
          <a href="#my-token">My tokens</a>
          <a href="#history">History</a>
          {user?.role === 'admin' && <a href="#admin">Admin</a>}
          {(user?.role === 'operator' || user?.role === 'admin') && (
            <a href="#staff">Staff access</a>
          )}
          <a href="#account">{user ? 'Account' : 'Sign in'}</a>
        </nav>

        <span className="header-label">Campus services</span>
      </header>

      <main id="top" className="page-shell">
        <section className="hero">
          <div className="hero-content">
            <p className="eyebrow">Your campus, without the wait</p>
            <h1>Make your time count.</h1>

            <p className="hero-description">
              Join a service queue from anywhere on campus.
              Follow your token and see how many people are ahead.
            </p>

            <a className="primary-button hero-button" href="#services">
              Explore services <span aria-hidden="true">↓</span>
            </a>

            <p className="demo-note">
              <span aria-hidden="true">●</span>{' '}
              Queue information refreshes every 5 seconds
            </p>
          </div>
        </section>

        <section id="services" className="services-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Find your service</p>
              <h2>Where do you need to go?</h2>
            </div>
            <p>Choose a service to see your place in line.</p>
          </div>

          {isLoading && <p role="status">Loading services…</p>}

          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}

          {!isLoading && !error && services.length === 0 && (
            <p>No services are available yet.</p>
          )}

          <div className="service-grid">
            {services.map((service) => (
              <article className="service-card" key={service.id}>
                <div className="card-topline">
                  <span
                    className={`status-pill ${
                      service.isOpen ? 'status-open' : 'status-closed'
                    }`}
                  >
                    <span aria-hidden="true">●</span>{' '}
                    {service.isOpen ? 'Open now' : 'Closed'}
                  </span>

                  <span className="service-number">
                    {String(service.id).padStart(2, '0')}
                  </span>
                </div>

                <h3>{service.name}</h3>
                <p className="service-description">{service.description}</p>

                <div className="service-details">
                  <div>
                    <span className="detail-label">Hours today</span>
                    <span>{service.hours}</span>
                  </div>

                  <div>
                    <span className="detail-label">In the queue</span>
                    <span>{service.peopleWaiting} people</span>
                  </div>
                </div>

                <div className="card-footer">
                  <span className="wait-time">
                    {!service.isOpen
                      ? 'Not accepting new visitors'
                      : service.estimatedWait == null
                        ? (service.activeCounters === 0 ? 'No counters enabled' : 'Wait estimate: not enough data')
                        : `Estimated wait: ${service.estimatedWait} min`}
                  </span>

                  <button
                    className="primary-button join-button"
                    type="button"
                    disabled={
                      !service.isOpen ||
                      isCheckingLogin ||
                      isLoggingIn ||
                      isCreatingAccount ||
                      isLoggingOut ||
                      joiningServiceId !== null ||
                      cancellingTokenId !== null
                    }
                    onClick={() => joinQueue(service)}
                  >
                    {joiningServiceId === service.id
                      ? 'Joining…'
                      : service.isOpen
                        ? 'Join queue'
                        : 'Closed'}

                    {service.isOpen &&
                      joiningServiceId !== service.id && (
                        <span aria-hidden="true">↗</span>
                      )}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section id="account" className="account-section">
          <div>
            <p className="eyebrow">Your account</p>

            {isCheckingLogin ? (
              <p role="status">Checking your sign-in…</p>
            ) : user ? (
              <>
                <h2>Welcome, {user.name}.</h2>
                <p>Signed in as {user.email}</p>

                <button
                  className="text-button"
                  type="button"
                  onClick={handleLogout}
                  disabled={isLoggingOut || joiningServiceId !== null || cancellingTokenId !== null}
                >
                  {isLoggingOut ? 'Signing out…' : 'Sign out'}
                </button>
              </>
            ) : (
              <>
                <h2>{isRegistering ? 'Create your account' : 'Sign in to join a queue'}</h2>

                <form
                  className="login-form"
                  onSubmit={isRegistering ? handleRegister : handleLogin}
                >
                  {isRegistering && (
                    <label>
                      Full name
                      <input
                        type="text"
                        value={fullName}
                        onChange={(event) => setFullName(event.target.value)}
                        autoComplete="name"
                        maxLength={100}
                        disabled={isCreatingAccount}
                        required
                      />
                    </label>
                  )}

                  <label>
                    Email
                    <input
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      autoComplete="email"
                      maxLength={254}
                      disabled={isLoggingIn || isCreatingAccount}
                      required
                    />
                  </label>

                  <label>
                    Password
                    <input
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete={isRegistering ? 'new-password' : 'current-password'}
                      minLength={isRegistering ? 8 : undefined}
                      disabled={isLoggingIn || isCreatingAccount}
                      required
                    />
                  </label>

                  <button
                    className="primary-button"
                    type="submit"
                    disabled={isLoggingIn || isCreatingAccount}
                  >
                    {isCreatingAccount
                      ? 'Creating account…'
                      : isLoggingIn
                        ? 'Signing in…'
                        : isRegistering
                          ? 'Create account'
                          : 'Sign in'}
                  </button>
                </form>

                <button
                  className="mode-switch"
                  type="button"
                  disabled={isLoggingIn || isCreatingAccount}
                  onClick={() => {
                    setIsRegistering((value) => !value)
                    setLoginMessage('')
                  }}
                >
                  {isRegistering
                    ? 'Already have an account? Sign in'
                    : 'New to QueueLess? Create an account'}
                </button>
              </>
            )}

            {loginMessage && <p role="status">{loginMessage}</p>}
          </div>
        </section>

        <section id="my-token" className="token-section">
          <div className="tokens-content">
            <p className="eyebrow">Your places in line</p>

            <div aria-live="polite">
              <h2>
                {isCheckingLogin
                  ? 'Checking your account…'
                  : !user
                    ? 'Your next turn starts here.'
                    : myTokens.length > 0
                      ? 'Your active tokens.'
                      : tokenLoadError
                        ? 'Token information is unavailable.'
                        : !lastTokenUpdate
                          ? 'Loading your tokens…'
                          : 'No active tokens yet.'}
              </h2>

              {user && myTokens.length === 0 && lastTokenUpdate && (
                <p>Choose an open service to join its queue.</p>
              )}

              <div className="token-list">
                {myTokens.map((token) => (
                  <article className="active-token" key={token.id}>
                    <div>
                      <h3>{token.serviceName}</h3>
                      <p>Status: {{ WAITING: 'Waiting', CALLED: 'Called', SERVING: 'Service in progress' }[token.status] || token.status}</p>
                      {token.status === 'WAITING' && <p>People ahead: {token.peopleAhead}</p>}
                      {token.status === 'WAITING' && (
                        <p>{tokenWaitLabel(token, services)}</p>
                      )}
                      {token.status === 'CALLED' && (
                        <p role="status">It’s your turn! Please go to {token.counterName || 'your assigned counter'} at {token.serviceName}.</p>
                      )}
                      {token.status === 'SERVING' && (
                        <p>Your visit is in progress at {token.counterName || 'your assigned counter'}.</p>
                      )}
                      {token.status === 'WAITING' && (
                        <button
                          className="cancel-button"
                          type="button"
                          onClick={() => cancelToken(token)}
                          disabled={
                            cancellingTokenId !== null ||
                            joiningServiceId !== null ||
                            isLoggingOut
                          }
                          aria-label={`Cancel ${token.number} for ${token.serviceName}`}
                        >
                          {cancellingTokenId === token.id ? 'Cancelling…' : 'Cancel token'}
                        </button>
                      )}
                    </div>
                    <div className="token-badge">
                      <span>Your token</span>
                      <strong>{token.number}</strong>
                    </div>
                  </article>
                ))}
              </div>
            </div>

            {user && lastTokenUpdate && (
              <p>
                Last successful update: {lastTokenUpdate.toLocaleTimeString()}
                {' · '}Local time
              </p>
            )}

            {user && <p>Refreshes every 5 seconds.</p>}

            {queueMessage && (
              <p className="queue-success" role="status">{queueMessage}</p>
            )}

            {queueError && (
              <p className="error-message" role="alert">{queueError}</p>
            )}
            {tokenLoadError && (
              <p className="error-message" role="alert">{tokenLoadError}</p>
            )}
            {!user && !isCheckingLogin && (
              <a href="#account">Sign in to view your tokens</a>
            )}
          </div>
        </section>
        <TokenHistory
          user={user}
          refreshVersion={refreshVersion}
          requestJson={requestJson}
          isBusy={
            isCheckingLogin || isLoggingOut ||
            joiningServiceId !== null || cancellingTokenId !== null
          }
        />
        {!isCheckingLogin && !isLoggingOut && user && (
          <StaffAccess
            key={user.id}
            user={user}
            requestJson={requestJson}
            onQueueChange={() => setRefreshVersion((current) => current + 1)}
          />
        )}
        {user?.role === 'admin' && !isLoggingOut && (
          <AdminPanel key={user.id} user={user} requestJson={requestJson} onChange={() => setRefreshVersion((v) => v + 1)} />
        )}
        <AppFeatures />
      </main>

      <footer className="site-footer">
        <span>QueueLess</span>
        <span>Campus services, made easier.</span>
      </footer>
    </>
  )
}

export default App
