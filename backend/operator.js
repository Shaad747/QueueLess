const validId = (value) => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 2147483647
const numberLabel = (n) => `Q-${String(n).padStart(3, '0')}`
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

class ActionError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

// Used only inside a transaction; locks coordinate with local role/assignment edits.
async function lockAccess(client, userId, counterId) {
  const user = (await client.query('SELECT role FROM users WHERE id = $1 FOR SHARE', [userId])).rows[0]
  if (!user) throw new ActionError(401, 'Please sign in again.')
  if (!['admin', 'operator'].includes(user.role)) throw new ActionError(403, 'This area is for staff only.')
  const initial = (await client.query('SELECT service_id FROM counters WHERE id = $1', [counterId])).rows[0]
  if (!initial) throw new ActionError(404, 'Counter not found or not assigned to you.')
  // Join and call-next both lock the service before touching queue rows.
  const service = (await client.query('SELECT id, is_open FROM services WHERE id = $1 FOR UPDATE', [initial.service_id])).rows[0]
  const counter = (await client.query('SELECT id, service_id, active FROM counters WHERE id = $1 FOR UPDATE', [counterId])).rows[0]
  if (!counter || counter.service_id !== initial.service_id) throw new ActionError(409, 'Counter changed. Refresh and try again.')
  if (user.role === 'operator') {
    const assignment = await client.query('SELECT counter_id FROM counter_assignments WHERE counter_id = $1 AND operator_id = $2 FOR SHARE', [counterId, userId])
    if (!assignment.rows.length) throw new ActionError(404, 'Counter not found or not assigned to you.')
  }
  return { ...counter, serviceOpen: service.is_open }
}

export function mountOperatorRoutes(app, pool, requireStaff) {
  app.get('/api/staff/counters/:counterId/desk', requireStaff, async (req, res) => {
    if (!validId(req.params.counterId)) return res.status(400).json({ message: 'Invalid counter ID.' })
    let client
    try {
      client = await pool.connect()
      await client.query('BEGIN')
      const counter = await lockAccess(client, req.session.userId, Number(req.params.counterId))
      const current = await client.query(`
        SELECT t.id, t.token_number, t.status, t.service_date::text AS "serviceDate",
               u.name AS "visitorName", v.called_at AS "calledAt", v.started_at AS "startedAt"
        FROM service_visits v JOIN queue_tokens t ON t.id = v.token_id
        JOIN users u ON u.id = t.visitor_id
        WHERE v.counter_id = $1 AND v.ended_at IS NULL
      `, [counter.id])
      const waiting = await client.query(`
        SELECT id, token_number, issued_at AS "issuedAt", count(*) OVER ()::integer AS total
        FROM queue_tokens WHERE service_id = $1 AND service_date = CURRENT_DATE AND status = 'WAITING'
        ORDER BY token_number LIMIT 10
      `, [counter.service_id])
      await client.query('COMMIT')
      const active = current.rows[0]
      res.json({
        counter: { id: counter.id, active: counter.active, serviceOpen: counter.serviceOpen },
        currentToken: active ? { ...active, number: numberLabel(active.token_number), token_number: undefined } : null,
        waitingCount: waiting.rows[0]?.total || 0,
        waiting: waiting.rows.map(({ total, token_number, ...row }) => ({ ...row, number: numberLabel(token_number) })),
      })
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {})
      if (!error.status) console.error('Operator desk failed:', error.message)
      res.status(error.status || 500).json({ message: error.status ? error.message : 'Unable to load the operator desk.' })
    } finally { client?.release() }
  })

  app.post('/api/staff/counters/:counterId/actions', requireStaff, async (req, res) => {
    // A custom JSON header requires a browser CORS preflight across origins.
    // This server does not allow cross-origin requests. Reject cross-site fetches too.
    if (req.get('X-QueueLess-Action') !== 'operator' || !req.is('application/json') || req.get('Sec-Fetch-Site') === 'cross-site') {
      return res.status(403).json({ message: 'Please submit this action from QueueLess.' })
    }
    const { action, tokenId = null, requestId } = req.body || {}
    if (!validId(req.params.counterId) || !['call-next', 'start', 'complete', 'no-show'].includes(action) || typeof requestId !== 'string' || !uuidPattern.test(requestId) || (action === 'call-next' ? tokenId !== null : !validId(tokenId))) {
      return res.status(400).json({ message: 'Invalid operator action. Refresh your desk and try again.' })
    }
    const counterId = Number(req.params.counterId)
    let client
    try {
      client = await pool.connect()
      await client.query('BEGIN')
      const counter = await lockAccess(client, req.session.userId, counterId)
      // Serializes a request key even if an accidental retry names a different counter.
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [req.session.userId, requestId])
      const previous = (await client.query('SELECT counter_id, action, token_id, response FROM operator_requests WHERE actor_id = $1 AND request_id = $2', [req.session.userId, requestId])).rows[0]
      if (previous) {
        if (previous.counter_id !== counterId || previous.action !== action || previous.token_id !== (tokenId === null ? null : Number(tokenId))) {
          throw new ActionError(409, 'This request ID was already used for another action.')
        }
        await client.query('COMMIT')
        return res.json(previous.response)
      }
      const active = (await client.query(`
        SELECT t.id, t.token_number, t.status FROM service_visits v
        JOIN queue_tokens t ON t.id = v.token_id
        WHERE v.counter_id = $1 AND v.ended_at IS NULL FOR UPDATE OF t, v
      `, [counterId])).rows[0]
      let token
      let status
      let message
      if (action === 'call-next') {
        if (!counter.active || !counter.serviceOpen) throw new ActionError(409, 'This counter or service is closed. You can finish an existing visit.')
        if (active) throw new ActionError(409, 'Finish the current visitor before calling another.')
        token = (await client.query(`
          SELECT id, token_number FROM queue_tokens
          WHERE service_id = $1 AND service_date = CURRENT_DATE AND status = 'WAITING'
          ORDER BY token_number LIMIT 1 FOR UPDATE
        `, [counter.service_id])).rows[0]
        if (!token) throw new ActionError(409, 'No visitors are waiting in this service today.')
        status = 'CALLED'
        await client.query('INSERT INTO service_visits(token_id, counter_id) VALUES ($1, $2)', [token.id, counterId])
        message = `${numberLabel(token.token_number)} called. Ask the visitor to come to your counter.`
      } else {
        if (!active || active.id !== Number(tokenId)) throw new ActionError(409, 'This visitor is no longer active at your counter. Refresh the desk.')
        token = active
        if (action === 'start') {
          if (token.status !== 'CALLED') throw new ActionError(409, 'Only a called visitor can start service.')
          status = 'SERVING'
          await client.query('UPDATE service_visits SET started_at = clock_timestamp() WHERE token_id = $1', [token.id])
          message = `Service started for ${numberLabel(token.token_number)}.`
        } else if (action === 'complete') {
          if (token.status !== 'SERVING') throw new ActionError(409, 'Start service before completing the visit.')
          status = 'COMPLETED'
          await client.query('UPDATE service_visits SET completed_at = statement_timestamp(), ended_at = statement_timestamp() WHERE token_id = $1', [token.id])
          message = `${numberLabel(token.token_number)} completed. You can call the next visitor.`
        } else {
          if (token.status !== 'CALLED') throw new ActionError(409, 'Only a called visitor can be marked absent.')
          status = 'NO_SHOW'
          await client.query('UPDATE service_visits SET ended_at = clock_timestamp() WHERE token_id = $1', [token.id])
          message = `${numberLabel(token.token_number)} marked absent. You can call the next visitor.`
        }
      }
      await client.query('UPDATE queue_tokens SET status = $1 WHERE id = $2', [status, token.id])
      await client.query('INSERT INTO queue_events(token_id, actor_id, event_type) VALUES ($1, $2, $3)', [token.id, req.session.userId, status])
      const response = { message, token: { id: token.id, number: numberLabel(token.token_number), status } }
      await client.query('INSERT INTO operator_requests(actor_id, request_id, counter_id, action, token_id, response) VALUES ($1, $2, $3, $4, $5, $6)', [req.session.userId, requestId, counterId, action, tokenId, JSON.stringify(response)])
      await client.query('COMMIT')
      res.json(response)
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {})
      if (!error.status) console.error('Operator action failed:', error.message)
      res.status(error.status || 500).json({ message: error.status ? error.message : 'Unable to confirm this action. Retry using the same request.' })
    } finally { client?.release() }
  })
}
