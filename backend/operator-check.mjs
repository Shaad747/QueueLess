// Creates a separate temporary database, runs real SQL/handler checks, then drops it.
// Run from backend after copying the new files: node operator-check.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID, randomBytes } from 'node:crypto'
import pg from 'pg'
import pool from './db.js'
import { mountStaffRoutes } from './staff.js'

const database = `queueless_check_${randomBytes(6).toString('hex')}`
let testPool
let created = false
let passed = 0
function check(value, message) { assert.ok(value, message); passed += 1 }
try {
  await pool.query(`CREATE DATABASE "${database}"`)
  created = true
  const bootstrap = await pool.connect()
  const parameters = bootstrap.connectionParameters
  bootstrap.release()
  // Do not spread a DATABASE_URL here: pg can let it override the test database.
  testPool = new pg.Pool({ host:parameters.host, port:parameters.port, user:parameters.user,
    password:parameters.password, ssl:parameters.ssl, options:parameters.options,
    database, max:8, connectionTimeoutMillis:5000 })
  const actualDatabase=(await testPool.query('SELECT current_database() AS name')).rows[0].name
  if(actualDatabase!==database) throw new Error('Refusing to run checks outside the temporary database')
  for (const name of ['schema.sql', '002_users.sql', '003_queue_tokens.sql', '004_staff_permissions.sql', '005_operator_workflow.sql']) {
    await testPool.query(await readFile(new URL(name, import.meta.url), 'utf8'))
  }
  const users = (await testPool.query(`
    INSERT INTO users(name, email, password_hash, role) VALUES
    ('Visitor A','a@check.invalid','unused','visitor'),
    ('Operator','operator@check.invalid','unused','operator'),
    ('Admin','admin@check.invalid','unused','admin'),
    ('Unassigned','unassigned@check.invalid','unused','operator'),
    ('Visitor B','b@check.invalid','unused','visitor'),
    ('Visitor C','c@check.invalid','unused','visitor'),
    ('Visitor D','d@check.invalid','unused','visitor') RETURNING id
  `)).rows.map((row) => row.id)
  const [visitor, operator, admin, unassigned, b, c, d] = users
  const serviceId = (await testPool.query('SELECT id FROM services ORDER BY id LIMIT 1')).rows[0].id
  const first = (await testPool.query('SELECT id FROM counters WHERE service_id = $1 ORDER BY id LIMIT 1', [serviceId])).rows[0].id
  const second = (await testPool.query("INSERT INTO counters(service_id,name) VALUES ($1,'Counter 2') RETURNING id", [serviceId])).rows[0].id
  await testPool.query('INSERT INTO counter_assignments(counter_id, operator_id) VALUES ($1,$3),($2,$3)', [first, second, operator])
  const tokens = []
  for (const [index, id] of [visitor, b, c, d].entries()) {
    tokens.push((await testPool.query('INSERT INTO queue_tokens(service_id, visitor_id, service_date, token_number) VALUES ($1,$2,CURRENT_DATE,$3) RETURNING id', [serviceId, id, index + 1])).rows[0].id)
  }
  const routes = new Map()
  const app = {
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers) },
    post(path, ...handlers) { routes.set(`POST ${path}`, handlers) },
  }
  mountStaffRoutes(app, testPool)
  async function invoke(method, route, userId, counterId, body = {}, headers = true) {
    const handlers = routes.get(`${method} ${route}`)
    let code = 200
    let output
    const req = {
      session: { userId }, params: { counterId: String(counterId) }, body,
      get(name) { return name === 'X-QueueLess-Action' && headers ? 'operator' : undefined },
      is(type) { return type === 'application/json' },
    }
    const res = { set() {}, status(status) { code = status; return this }, json(data) { output = data; return this } }
    async function dispatch(index) {
      if (index >= handlers.length) return
      let nextResult
      await handlers[index](req, res, () => { nextResult = dispatch(index + 1) })
      await nextResult
    }
    await dispatch(0)
    return { status: code, body: output }
  }
  const deskRoute = '/api/staff/counters/:counterId/desk'
  const actionRoute = '/api/staff/counters/:counterId/actions'
  const desk = (who, counterId = first) => invoke('GET', deskRoute, who, counterId)
  const act = (who, counterId, action, tokenId = null, requestId = randomUUID(), headers = true) => invoke('POST', actionRoute, who, counterId, { action, tokenId, requestId }, headers)
  check((await desk(undefined)).status === 401, 'Unsigned staff access denied')
  check((await desk(visitor)).status === 403, 'Visitor staff access denied')
  check((await desk(unassigned)).status === 404, 'Unassigned operator denied')
  check((await desk(admin)).status === 200, 'Admin counter access')
  check((await desk(operator)).body.waitingCount === 4, 'Queue count')
  check((await act(operator, first, 'call-next', null, randomUUID(), false)).status === 403, 'Missing action header denied')
  check((await act(operator, first, 'call-next', null, 'bad')).status === 400, 'Bad request key denied')
  const firstKey = randomUUID()
  const called = await act(operator, first, 'call-next', null, firstKey)
  check(called.status === 200 && called.body.token.id === tokens[0], 'FIFO first token')
  check((await act(operator, first, 'complete', tokens[0])).status === 409, 'Cannot complete before starting')
  check((await act(operator, first, 'call-next')).status === 409, 'Occupied counter blocks next call')
  const raced = await Promise.all([act(operator, second, 'call-next'), act(operator, second, 'call-next')])
  check(raced.filter((item) => item.status === 200).length === 1, 'Concurrent same-counter calls have one winner')
  check(raced.find((item) => item.status === 200).body.token.id === tokens[1], 'Second FIFO token, no duplicate claim')
  check((await act(operator, first, 'start', tokens[0])).body.token.status === 'SERVING', 'Service start')
  check((await act(operator, first, 'no-show', tokens[0])).status === 409, 'Serving visitor cannot be absent')
  check((await act(operator, first, 'complete', tokens[0])).body.token.status === 'COMPLETED', 'Service completion')
  const replay = await act(operator, first, 'call-next', null, firstKey)
  check(replay.status === 200 && replay.body.token.id === tokens[0], 'Retry returns original result after completion')
  check((await desk(operator)).body.currentToken === null, 'Retry did not call another token')
  check((await act(operator, second, 'no-show', tokens[1])).body.token.status === 'NO_SHOW', 'Called visitor marked absent')
  await testPool.query('UPDATE services SET is_open = FALSE WHERE id = $1', [serviceId])
  check((await act(operator, first, 'call-next')).status === 409, 'Closed service denies next call')
  await testPool.query('UPDATE services SET is_open = TRUE WHERE id = $1', [serviceId])
  // Two different counters request the remaining visitors at the same time.
  const parallel = await Promise.all([act(operator, first, 'call-next'), act(operator, second, 'call-next')])
  check(parallel.every((item) => item.status === 200) && new Set(parallel.map((item) => item.body.token.id)).size === 2, 'Parallel counters claim distinct visitors')
  const current = (await desk(operator)).body.currentToken
  await testPool.query('UPDATE counters SET active = FALSE WHERE id = $1', [first])
  check((await act(operator, first, 'start', current.id)).status === 200, 'Disabled counter can finish existing visitor')
  check((await act(operator, first, 'complete', current.id)).status === 200, 'Disabled counter completion')
  await testPool.query('DELETE FROM counter_assignments WHERE counter_id = $1 AND operator_id = $2', [second, operator])
  check((await desk(operator, second)).status === 404, 'Revocation takes effect immediately')
  check((await act(operator, second, 'no-show', parallel.find((item) => item.body.token.id !== current.id).body.token.id)).status === 404, 'Revoked operator action denied')
  await testPool.query("UPDATE users SET role = 'visitor' WHERE id = $1", [operator])
  check((await desk(operator)).status === 403, 'Role demotion takes effect immediately')
  const history = await testPool.query("SELECT status FROM queue_tokens WHERE visitor_id = $1 AND status IN ('COMPLETED','CANCELLED','NO_SHOW')", [visitor])
  check(history.rows[0]?.status === 'COMPLETED', 'Completed token is eligible for visitor history')
  const counts = (await testPool.query("SELECT (SELECT count(*) FROM service_visits) AS visits, (SELECT count(*) FROM queue_events WHERE token_id = $1) AS first_events", [tokens[0]])).rows[0]
  check(Number(counts.visits) === 4 && Number(counts.first_events) === 3, 'One visit per token and one event per transition; retries add no events')
  console.log(`Passed ${passed} PostgreSQL and operator route checks in temporary database ${database}.`)
} catch (error) {
  console.error(`Check failed after ${passed} assertions: ${error.message}`)
  process.exitCode = 1
} finally {
  if (testPool) await testPool.end()
  if (created) {
    try { await pool.query(`DROP DATABASE "${database}"`) }
    catch (error) { console.error(`Could not remove temporary database ${database}: ${error.message}`); process.exitCode = 1 }
  }
  await pool.end()
}
