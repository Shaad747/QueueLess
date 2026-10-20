import express from 'express'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { mountAdminRoutes } from './admin.js'
import { installSecurity } from './security.js'
import { serviceDirectorySql } from './estimates.js'
import bcrypt from 'bcryptjs'
import defaultPool from './db.js'
import session from 'express-session'
import connectPgSimple from 'connect-pg-simple'
import { mountStaffRoutes } from './staff.js'
const PORT = Number(process.env.PORT || 3000)
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('Invalid PORT')

export function createApp(pool = defaultPool, { production = process.env.NODE_ENV === 'production' } = {}) {
const app = express()
app.use(express.json({ limit:'16kb' }))
if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is missing from .env')
}

if (production && process.env.SESSION_SECRET.length < 32) throw new Error('Use a SESSION_SECRET of at least 32 characters')
installSecurity(app, pool, production)
const PgSessionStore = connectPgSimple(session)
const sessionStore = new PgSessionStore({pool,createTableIfMissing:true})
app.locals.sessionStore = sessionStore

app.use(
  session({
    name: 'queueless.sid',
    store: sessionStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: production,
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
)
mountStaffRoutes(app, pool)
mountAdminRoutes(app, pool)

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'QueueLess backend is running',
  })
})

app.get('/api/health/db', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT current_database() AS database'
    )

    res.json({
      status: 'ok',
      message: 'PostgreSQL connection successful',
      database: result.rows[0].database,
    })
  } catch (error) {
    console.error('Database connection failed:', error.message)

    res.status(503).json({
      status: 'error',
      message: 'Database connection failed',
    })
  }
})
app.get('/api/services', async (req, res) => {
  res.set('Cache-Control', 'no-store')

  try {
    const result = await pool.query(serviceDirectorySql)

    res.json(result.rows)
  } catch (error) {
    console.error('Failed to fetch services:', error.message)

    res.status(500).json({
      message: 'Unable to load services. Please try again.',
    })
  }
})
app.post('/api/auth/register', async (req, res) => {
  const name =
    typeof req.body?.name === 'string' ? req.body.name.trim() : ''
  const email =
    typeof req.body?.email === 'string'
      ? req.body.email.trim().toLowerCase()
      : ''
  const password =
    typeof req.body?.password === 'string' ? req.body.password : ''

  if (!name || !email || !password) {
    return res.status(400).json({
      message: 'Name, email, and password are required.',
    })
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      message: 'Enter a valid email address.',
    })
  }

  if (name.length > 100 || email.length > 254 || Buffer.byteLength(password,'utf8') > 72) {
    return res.status(400).json({ message:'Name must be at most 100 characters, email 254 characters, and password 72 UTF-8 bytes.' })
  }

  if (password.length < 8) {
    return res.status(400).json({
      message: 'Password must be at least 8 characters long.',
    })
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12)

    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, 'visitor')
       RETURNING id, name, email, role, created_at`,
      [name, email, passwordHash]
    )

    res.status(201).json({ user: result.rows[0] })
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        message: 'An account with that email already exists.',
      })
    }

    console.error('Registration failed:', error.message)
    res.status(500).json({
      message: 'Unable to create the account. Please try again.',
    })
  }
})
app.post('/api/auth/login', async (req, res) => {
  const email =
    typeof req.body?.email === 'string'
      ? req.body.email.trim().toLowerCase()
      : ''

  const password =
    typeof req.body?.password === 'string'
      ? req.body.password
      : ''

  if (!email || !password) {
    return res.status(400).json({
      message: 'Email and password are required.',
    })
  }

  if (email.length > 254 || Buffer.byteLength(password,'utf8') > 72) return res.status(400).json({ message:'Email or password is too long.' })

  try {
    const result = await pool.query(
      `SELECT id, name, email, role, password_hash
       FROM users
       WHERE LOWER(TRIM(email)) = $1`,
      [email]
    )

    const user = result.rows[0]

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({
        message: 'Incorrect email or password.',
      })
    }

    await new Promise((resolve, reject) => {
      req.session.regenerate((error) => {
        if (error) reject(error)
        else resolve()
      })
    })

    req.session.userId = user.id

    await new Promise((resolve, reject) => {
      req.session.save((error) => {
        if (error) reject(error)
        else resolve()
      })
    })

    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    })
  } catch (error) {
    console.error('Login failed:', error.message)

    res.status(500).json({
      message: 'Unable to log in. Please try again.',
    })
  }
})
app.get('/api/auth/me', async (req, res) => {
  res.set('Cache-Control', 'no-store')

  if (!req.session.userId) {
    return res.status(401).json({
      message: 'Please log in first.',
    })
  }

  try {
    const result = await pool.query(
      `SELECT id, name, email, role
       FROM users
       WHERE id = $1`,
      [req.session.userId]
    )

    if (result.rows.length === 0) {
      return res.status(401).json({
        message: 'Please log in again.',
      })
    }

    res.json({ user: result.rows[0] })
  } catch (error) {
    console.error('Failed to load account:', error.message)

    res.status(500).json({
      message: 'Unable to load your account.',
    })
  }
})
app.post('/api/queues/:serviceId/join', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({
      message: 'Please log in before joining a queue.',
    })
  }

  const serviceId = Number(req.params.serviceId)

  if (!Number.isSafeInteger(serviceId) || serviceId < 1 || serviceId > 2147483647) {
    return res.status(400).json({
      message: 'Invalid service.',
    })
  }

  let client

  try {
    client = await pool.connect()
    await client.query('BEGIN')

    const serviceResult = await client.query(
      'SELECT id, name, is_open FROM services WHERE id = $1 FOR UPDATE',
      [serviceId]
    )
    const service = serviceResult.rows[0]

    if (!service) {
      await client.query('ROLLBACK')
      return res.status(404).json({
        message: 'Service not found.',
      })
    }

    const existingResult = await client.query(
      `SELECT id, token_number, status, service_date, issued_at
       FROM queue_tokens
       WHERE service_id = $1
         AND visitor_id = $2
         AND service_date = CURRENT_DATE
         AND status IN ('WAITING', 'CALLED', 'SERVING')`,
      [serviceId, req.session.userId]
    )

    if (existingResult.rows.length > 0) {
      const token = existingResult.rows[0]
      const aheadResult = await client.query(
        `SELECT COUNT(*)::int AS people_ahead
         FROM queue_tokens
         WHERE service_id = $1
           AND service_date = $2
           AND token_number < $3
           AND status IN ('WAITING', 'CALLED', 'SERVING')`,
        [serviceId, token.service_date, token.token_number]
      )

      await client.query('COMMIT')
      return res.status(200).json({
        token: {
          id: token.id,
          serviceId,
          serviceName: service.name,
          date: token.service_date,
          number: `Q-${String(token.token_number).padStart(3, '0')}`,
          status: token.status,
          peopleAhead: aheadResult.rows[0].people_ahead,
          issuedAt: token.issued_at,
        },
      })
    }

    if (!service.is_open) {
      await client.query('ROLLBACK')
      return res.status(409).json({
        message: 'This service is closed.',
      })
    }

    const sequenceResult = await client.query(
      `INSERT INTO daily_sequences (service_id, service_date, next_number)
       VALUES ($1, CURRENT_DATE, 2)
       ON CONFLICT (service_id, service_date)
       DO UPDATE SET next_number = daily_sequences.next_number + 1
       RETURNING next_number - 1 AS token_number`,
      [serviceId]
    )
    const tokenNumber = sequenceResult.rows[0].token_number

    const tokenResult = await client.query(
      `INSERT INTO queue_tokens
         (service_id, visitor_id, service_date, token_number)
       VALUES ($1, $2, CURRENT_DATE, $3)
       RETURNING id, service_date, token_number, status, issued_at`,
      [serviceId, req.session.userId, tokenNumber]
    )

    await client.query("INSERT INTO queue_events(token_id,actor_id,event_type) VALUES ($1,$2,'JOINED')", [tokenResult.rows[0].id,req.session.userId])
    await client.query('UPDATE services SET business_date=CURRENT_DATE WHERE id=$1 AND business_date<>CURRENT_DATE',[serviceId])

    const aheadResult = await client.query(
      `SELECT COUNT(*)::int AS people_ahead
       FROM queue_tokens
       WHERE service_id = $1
         AND service_date = CURRENT_DATE
         AND token_number < $2
         AND status IN ('WAITING', 'CALLED', 'SERVING')`,
      [serviceId, tokenNumber]
    )

    await client.query('COMMIT')

    res.status(201).json({
      token: {
        id: tokenResult.rows[0].id,
        serviceId,
        serviceName: service.name,
        date: tokenResult.rows[0].service_date,
        number: `Q-${String(tokenNumber).padStart(3, '0')}`,
        status: tokenResult.rows[0].status,
        peopleAhead: aheadResult.rows[0].people_ahead,
        issuedAt: tokenResult.rows[0].issued_at,
      },
    })
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // The transaction may already have been rolled back.
      }
    }

    console.error('Could not join queue:', error.message)
    res.status(500).json({
      message: 'Unable to join the queue. Please try again.',
    })
  } finally {
    client?.release()
  }
})
app.get('/api/queues/my-token', async (req, res) => {
  res.set('Cache-Control', 'no-store')

  if (!req.session.userId) {
    return res.status(401).json({
      message: 'Please log in to view your token.',
    })
  }

  try {
    const result = await pool.query(
      `SELECT
         t.id,
         t.service_id AS "serviceId",
         s.name AS "serviceName",
         t.service_date AS date,
         t.token_number,
         t.status,
         c.id AS "counterId",
         c.name AS "counterName",
         t.issued_at AS "issuedAt",
         (
           SELECT COUNT(*)::int
           FROM queue_tokens AS ahead
           WHERE ahead.service_id = t.service_id
             AND ahead.service_date = t.service_date
             AND ahead.token_number < t.token_number
             AND ahead.status IN ('WAITING', 'CALLED', 'SERVING')
         ) AS "peopleAhead"
       FROM queue_tokens AS t
       JOIN services AS s ON s.id = t.service_id
       LEFT JOIN service_visits AS v ON v.token_id = t.id AND v.ended_at IS NULL
       LEFT JOIN counters AS c ON c.id = v.counter_id
       WHERE t.visitor_id = $1
         AND t.service_date = CURRENT_DATE
         AND t.status IN ('WAITING', 'CALLED', 'SERVING')
       ORDER BY t.issued_at DESC
       LIMIT 1`,
      [req.session.userId]
    )

    const row = result.rows[0]

    if (!row) {
      return res.json({ token: null })
    }

    res.json({
      token: {
        id: row.id,
        serviceId: row.serviceId,
        serviceName: row.serviceName,
        date: row.date,
        number: `Q-${String(row.token_number).padStart(3, '0')}`,
        status: row.status,
        counterId: row.counterId,
        counterName: row.counterName,
        peopleAhead: row.peopleAhead,
        issuedAt: row.issuedAt,
      },
    })
  } catch (error) {
    console.error('Could not load token:', error.message)
    res.status(500).json({
      message: 'Unable to load your token. Please try again.',
    })
  }
})
app.get('/api/queues/my-tokens', async (req, res) => {
  res.set('Cache-Control', 'no-store')

  if (!req.session.userId) {
    return res.status(401).json({
      message: 'Please log in to view your token.',
    })
  }

  try {
    const result = await pool.query(
      `SELECT
         t.id,
         t.service_id AS "serviceId",
         s.name AS "serviceName",
         t.service_date AS date,
         t.token_number,
         t.status,
         c.id AS "counterId",
         c.name AS "counterName",
         t.issued_at AS "issuedAt",
         (
           SELECT COUNT(*)::int
           FROM queue_tokens AS ahead
           WHERE ahead.service_id = t.service_id
             AND ahead.service_date = t.service_date
             AND ahead.token_number < t.token_number
             AND ahead.status IN ('WAITING', 'CALLED', 'SERVING')
         ) AS "peopleAhead"
       FROM queue_tokens AS t
       JOIN services AS s ON s.id = t.service_id
       LEFT JOIN service_visits AS v ON v.token_id = t.id AND v.ended_at IS NULL
       LEFT JOIN counters AS c ON c.id = v.counter_id
       WHERE t.visitor_id = $1
         AND t.service_date = CURRENT_DATE
         AND t.status IN ('WAITING', 'CALLED', 'SERVING')
       ORDER BY t.issued_at DESC, t.id DESC`,
      [req.session.userId]
    )

    res.json({
      tokens: result.rows.map((row) => ({
        id: row.id,
        serviceId: row.serviceId,
        serviceName: row.serviceName,
        date: row.date,
        number: `Q-${String(row.token_number).padStart(3, '0')}`,
        status: row.status,
        counterId: row.counterId,
        counterName: row.counterName,
        peopleAhead: row.peopleAhead,
        issuedAt: row.issuedAt,
      })),
    })
  } catch (error) {
    console.error('Could not load token:', error.message)
    res.status(500).json({
      message: 'Unable to load your token. Please try again.',
    })
  }
})
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      console.error('Logout failed:', error.message)
      return res.status(500).json({
        message: 'Unable to sign out. Please try again.',
      })
    }

    res.clearCookie('queueless.sid', {
      httpOnly: true,
      sameSite: 'lax',
      secure: production,
      path: '/',
    })

    res.json({ message: 'Signed out successfully.' })
  })
})
app.post('/api/tokens/:tokenId/cancel', async (req, res) => {
  res.set('Cache-Control', 'no-store')

  if (!req.session.userId) {
    return res.status(401).json({
      message: 'Please sign in before cancelling a token.',
    })
  }

  const tokenId = Number(req.params.tokenId)

  if (!Number.isSafeInteger(tokenId) || tokenId < 1 || tokenId > 2147483647) {
    return res.status(400).json({
      message: 'Invalid token.',
    })
  }

  try {
    const result = await pool.query(
      `WITH cancelled AS (
         UPDATE queue_tokens SET status='CANCELLED'
         WHERE id=$1 AND visitor_id=$2 AND status='WAITING'
         RETURNING id,token_number,status
       ), logged AS (
         INSERT INTO queue_events(token_id,actor_id,event_type)
         SELECT id,$2,'CANCELLED' FROM cancelled RETURNING id
       ) SELECT id,token_number,status FROM cancelled`,
      [tokenId, req.session.userId]
    )

    if (result.rows.length > 0) {
      const token = result.rows[0]

      return res.json({
        message: 'Your token has been cancelled.',
        token: {
          id: token.id,
          number: `Q-${String(token.token_number).padStart(3, '0')}`,
          status: token.status,
        },
      })
    }

    const existing = await pool.query(
      `SELECT status
       FROM queue_tokens
       WHERE id = $1 AND visitor_id = $2`,
      [tokenId, req.session.userId]
    )

    if (existing.rows.length === 0) {
      return res.status(404).json({
        message: 'Token not found.',
      })
    }

    // A repeated cancellation request is safe.
    if (existing.rows[0].status === 'CANCELLED') {
      return res.json({
        message: 'This token is already cancelled.',
        token: {
          id: tokenId,
          status: 'CANCELLED',
        },
      })
    }

    return res.status(409).json({
      message: 'Only a waiting token can be cancelled. Its status has changed.',
    })
  } catch (error) {
    console.error('Cancellation failed:', error.message)

    res.status(500).json({
      message: 'Unable to cancel your token. Please try again.',
    })
  }
})
// Finished tokens belong to the signed-in visitor. Pagination uses the last ID.
app.get('/api/queues/history', async (req, res) => {
  res.set('Cache-Control', 'no-store')

  if (!req.session.userId) {
    return res.status(401).json({ message: 'Please sign in to view your history.' })
  }

  const rawBefore = req.query.before
  let beforeId = null

  if (rawBefore !== undefined) {
    if (typeof rawBefore !== 'string' || !/^[1-9]\d*$/.test(rawBefore)) {
      return res.status(400).json({ message: 'Invalid history page.' })
    }
    beforeId = Number(rawBefore)
    if (!Number.isSafeInteger(beforeId) || beforeId > 2147483647) {
      return res.status(400).json({ message: 'Invalid history page.' })
    }
  }

  const pageSize = 20

  try {
    const result = await pool.query(
      `SELECT
         t.id,
         t.service_id AS "serviceId",
         s.name AS "serviceName",
         t.service_date::text AS "serviceDate",
         t.token_number,
         t.status,
         t.issued_at AS "issuedAt"
       FROM queue_tokens AS t
       JOIN services AS s ON s.id = t.service_id
       WHERE t.visitor_id = $1
         AND t.status IN ('COMPLETED', 'CANCELLED', 'NO_SHOW')
         AND ($2::integer IS NULL OR t.id < $2::integer)
       ORDER BY t.id DESC
       LIMIT $3`,
      [req.session.userId, beforeId, pageSize + 1]
    )

    const rows = result.rows.slice(0, pageSize)
    res.json({
      tokens: rows.map((row) => ({
        id: row.id,
        serviceId: row.serviceId,
        serviceName: row.serviceName,
        serviceDate: row.serviceDate,
        number: `Q-${String(row.token_number).padStart(3, '0')}`,
        status: row.status,
        issuedAt: row.issuedAt,
      })),
      nextCursor: result.rows.length > pageSize ? rows[rows.length - 1].id : null,
    })
  } catch (error) {
    console.error('Could not load token history:', error.message)
    res.status(500).json({ message: 'Unable to load your history. Please try again.' })
  }
})

// Serve the built frontend and API from one origin in production.
if (production || process.env.SERVE_FRONTEND === 'true') {
  const dist = fileURLToPath(new URL('../frontend/dist/', import.meta.url))
  app.use(express.static(dist, { setHeaders(res, file) {
    if (file.endsWith('sw.js') || file.endsWith('index.html') || file.endsWith('.webmanifest')) res.set('Cache-Control','no-cache')
  } }))
  app.get(/^(?!\/api(?:\/|$)).*/, (req,res,next) => {
    if (path.extname(req.path) || !req.accepts('html')) return next()
    res.sendFile(path.join(dist,'index.html'))
  })
}
app.use('/api', (req,res) => res.status(404).json({message:'API endpoint not found.'}))
app.use((error,req,res,next) => {
  if (res.headersSent) return next(error)
  const status = error.type === 'entity.too.large' ? 413 : error instanceof SyntaxError && error.status === 400 ? 400 : 500
  if (status === 500) console.error('Request failed:',error.message)
  res.status(status).json({ message: status === 413 ? 'Request is too large.' : status === 400 ? 'Invalid JSON request.' : 'Request failed. Please try again.' })
})
return app
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp()
  const server = app.listen(PORT, () => console.log(`QueueLess backend running at http://localhost:${PORT}`))
  let stopping = false
  async function shutdown() {
    if (stopping) return
    stopping = true
    server.close(async () => { await app.locals.sessionStore.close(); await defaultPool.end(); process.exit(0) })
    setTimeout(() => process.exit(1),10000).unref()
  }
  process.on('SIGTERM',shutdown)
  process.on('SIGINT',shutdown)
}
