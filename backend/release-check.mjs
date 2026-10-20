// Creates a separate temporary database, runs real SQL/handler checks, then drops it.
// Run from backend after copying the new files: node release-check.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID, randomBytes } from 'node:crypto'
import pg from 'pg'
import pool from './db.js'
import { mountStaffRoutes } from './staff.js'
import { mountAdminRoutes } from './admin.js'
import { serviceDirectorySql } from './estimates.js'
import bcrypt from 'bcryptjs'
import { once } from 'node:events'
import { createApp } from './server.js'
import { performance } from 'node:perf_hooks'

const database = `queueless_check_${randomBytes(6).toString('hex')}`
let testPool
let created = false
let passed = 0
let httpServer
let httpApp
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
  for (const name of ['schema.sql', '002_users.sql', '003_queue_tokens.sql', '004_staff_permissions.sql', '005_operator_workflow.sql', '006_admin_reports.sql']) {
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
    put(path, ...handlers) { routes.set(`PUT ${path}`, handlers) },
  }
  mountStaffRoutes(app, testPool)
  mountAdminRoutes(app, testPool)
  async function invoke(method, route, userId, counterId, body = {}, headers = true) {
    const handlers = routes.get(`${method} ${route}`)
    let code = 200
    let output
    const req = {
      session: { userId }, params: { counterId: String(counterId), id:String(counterId) }, body, query:body.query || {},
      get(name) { return name === 'X-QueueLess-Action' && headers ? (route.startsWith('/api/admin') ? 'admin' : 'operator') : undefined },
      is(type) { return type === 'application/json' },
    }
    const res = { set() { return this }, send(data) { output=data; return this }, status(status) { code = status; return this }, json(data) { output = data; return this } }
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
  check((await invoke('GET','/api/admin/overview',visitor,first)).status===403,'Visitors cannot read admin overview')
  check((await invoke('GET','/api/admin/reports',undefined,first)).status===401,'Unsigned reports denied')
  check((await invoke('GET','/api/admin/overview',admin,first)).status===200,'Admin overview')
  check((await invoke('GET','/api/admin/reports',admin,first,{query:{date:'2026-02-30'}})).status===400,'Invalid calendar date rejected')
  check((await invoke('PUT','/api/admin/users/:id/role',admin,admin,{role:'visitor'})).status===409,'Self-demotion prevented')
  check((await invoke('PUT','/api/admin/users/:id/role',admin,operator,{role:'operator'})).status===200,'Admin promotes staff')
  const createdService=await invoke('POST','/api/admin/services',admin,first,{name:'Release service',description:'Check service',hours:'9–5',isOpen:true})
  check(createdService.status===200,'Admin creates service')
  const newService=createdService.body.entityId
  const createdCounter=await invoke('POST','/api/admin/counters',admin,first,{serviceId:newService,name:'Release counter',active:true})
  check(createdCounter.status===200,'Admin creates counter')
  check((await invoke('PUT','/api/admin/assignments',admin,first,{operatorId:operator,counterId:createdCounter.body.entityId,assigned:true})).status===200,'Admin assigns operator')
  check((await desk(operator,createdCounter.body.entityId)).status===200,'Assignment grants access')
  check((await invoke('PUT','/api/admin/assignments',admin,first,{operatorId:operator,counterId:createdCounter.body.entityId,assigned:false})).status===200,'Admin revokes assignment')
  check((await desk(operator,createdCounter.body.entityId)).status===404,'Revocation removes access')
  check((await invoke('POST','/api/admin/services',admin,first,{name:'Release service',description:'Duplicate',hours:'9–5',isOpen:true})).status===409,'Duplicate service does not create duplicate record')
  const reports=(await invoke('GET','/api/admin/reports',admin,first)).body.reports
  const rawCount=Number((await testPool.query('SELECT count(*) FROM queue_tokens WHERE service_date=CURRENT_DATE')).rows[0].count)
  check(reports.reduce((sum,row)=>sum+row.tokens,0)===rawCount,'Report volumes agree with source records')
  const originalReport=reports.find((row)=>row.serviceId===serviceId)
  check(originalReport.completed===2&&originalReport.noShows===1,'Report outcome counts')
  const directory=(await testPool.query(serviceDirectorySql)).rows
  check(directory.find((row)=>row.id===serviceId).estimatedWait===null,'No estimate with fewer than three samples')
  const sampleId=(await testPool.query("INSERT INTO queue_tokens(service_id,visitor_id,service_date,token_number,status,issued_at) VALUES ($1,$2,CURRENT_DATE,99,'COMPLETED',NOW()-INTERVAL '15 minutes') RETURNING id",[serviceId,visitor])).rows[0].id
  await testPool.query("INSERT INTO service_visits(token_id,counter_id,called_at,started_at,completed_at,ended_at) VALUES ($1,$2,NOW()-INTERVAL '12 minutes',NOW()-INTERVAL '10 minutes',NOW()-INTERVAL '5 minutes',NOW()-INTERVAL '5 minutes')",[sampleId,second])
  check((await testPool.query(serviceDirectorySql)).rows.find((row)=>row.id===serviceId).estimatedWait!==null,'Estimate appears with three completed samples')
  await testPool.query('UPDATE counters SET active=FALSE WHERE service_id=$1',[serviceId])
  check((await testPool.query(serviceDirectorySql)).rows.find((row)=>row.id===serviceId).estimatedWait===null,'No estimate without enabled counters')
  const csv=await invoke('GET','/api/admin/reports.csv',admin,first)
  check(csv.status===200&&csv.body.includes('serviceName')&&csv.body.includes('Student Services Desk'),'CSV export')
  const logCount=Number((await testPool.query('SELECT count(*) FROM admin_events')).rows[0].count)
  check(logCount>=5,'Admin changes have audit records')
  // Real HTTP session + visitor acceptance checks, all against the disposable DB.
  const password='Test-'+randomBytes(12).toString('hex')
  const hash=await bcrypt.hash(password,12)
  await testPool.query('UPDATE users SET password_hash=$1 WHERE id IN ($2,$3,$4)',[hash,visitor,b,admin])
  httpApp=createApp(testPool,{production:false})
  httpServer=httpApp.listen(0,'127.0.0.1')
  await once(httpServer,'listening')
  const base=`http://127.0.0.1:${httpServer.address().port}`
  async function http(url,{method='GET',cookie,body,custom=true}={}){
    const headers={}
    if(cookie)headers.Cookie=cookie
    if(method!=='GET'){headers['Content-Type']='application/json';if(custom)headers['X-QueueLess-Request']='1'}
    const response=await fetch(base+url,{method,headers,body:body===undefined?undefined:JSON.stringify(body)})
    return{status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]}
  }
  const aLogin=await http('/api/auth/login',{method:'POST',body:{email:'a@check.invalid',password}})
  const bLogin=await http('/api/auth/login',{method:'POST',body:{email:'b@check.invalid',password}})
  check(aLogin.status===200&&bLogin.status===200&&aLogin.cookie&&bLogin.cookie,'HTTP login creates separate server sessions')
  check((await http('/api/auth/me',{cookie:aLogin.cookie})).body.user.id===visitor,'HTTP session restoration')
  check((await http('/api/admin/overview',{cookie:aLogin.cookie})).status===403,'HTTP visitor denied admin')
  check((await http(`/api/queues/${newService}/join`,{method:'POST',cookie:aLogin.cookie,custom:false})).status===403,'HTTP mutations require CSRF header')
  const joined=await Promise.all([http(`/api/queues/${newService}/join`,{method:'POST',cookie:aLogin.cookie}),http(`/api/queues/${newService}/join`,{method:'POST',cookie:bLogin.cookie})])
  check(joined.every((r)=>r.status===201)&&new Set(joined.map((r)=>r.body.token.number)).size===2,'Simultaneous HTTP joins receive distinct tokens')
  const retry=await http(`/api/queues/${newService}/join`,{method:'POST',cookie:aLogin.cookie})
  check(retry.status===200&&retry.body.token.id===joined[0].body.token.id,'Repeated HTTP join returns original active token')
  const cancelled=await http(`/api/tokens/${joined[0].body.token.id}/cancel`,{method:'POST',cookie:aLogin.cookie})
  check(cancelled.status===200,'HTTP visitor cancellation')
  check((await testPool.query("SELECT id FROM queue_events WHERE token_id=$1 AND event_type='CANCELLED'",[joined[0].body.token.id])).rows.length===1,'Cancellation event committed with cancellation')
  const rejoined=await http(`/api/queues/${newService}/join`,{method:'POST',cookie:aLogin.cookie})
  check(rejoined.status===201&&rejoined.body.token.id!==joined[0].body.token.id&&rejoined.body.token.number==='Q-003','Rejoin moves visitor to queue end')
  check((await http('/api/queues/history',{cookie:aLogin.cookie})).body.tokens.some((t)=>t.id===joined[0].body.token.id&&t.status==='CANCELLED'),'Cancelled token remains in HTTP history')
  const registration=await http('/api/auth/register',{method:'POST',body:{name:'Public registration',email:'registered@check.invalid',password,role:'admin'}})
  check(registration.status===201&&registration.body.user.role==='visitor','Public registration cannot choose admin role')
  const cLogin=await http('/api/auth/login',{method:'POST',body:{email:'registered@check.invalid',password}})
  await testPool.query('UPDATE services SET is_open=FALSE WHERE id=$1',[newService])
  check((await http(`/api/queues/${newService}/join`,{method:'POST',cookie:cLogin.cookie})).status===409,'Closed service rejects new HTTP joins')
  await testPool.query('UPDATE services SET is_open=TRUE WHERE id=$1',[newService])
  await http('/api/auth/logout',{method:'POST',cookie:aLogin.cookie})
  check((await http('/api/auth/me',{cookie:aLogin.cookie})).status===401,'HTTP logout destroys server session')
  await new Promise((resolve)=>httpServer.close(resolve));httpServer=null
  await httpApp.locals.sessionStore.close();httpApp=null

  // Representative local dataset: 100 extra users and 1,000 historical tokens.
  await testPool.query("INSERT INTO users(name,email,password_hash) SELECT 'Load user '||n,'load-'||n||'@check.invalid','unused' FROM generate_series(1,100) n")
  await testPool.query("INSERT INTO queue_tokens(service_id,visitor_id,service_date,token_number,status) SELECT $1,u.id,CURRENT_DATE,100+row_number() OVER ()::integer,'COMPLETED' FROM (SELECT id FROM users WHERE email LIKE 'load-%@check.invalid') u CROSS JOIN generate_series(1,10)",[newService])
  const timings=[]
  for(let i=0;i<10;i++){const started=performance.now();await testPool.query(serviceDirectorySql);await invoke('GET','/api/admin/reports',admin,first);timings.push(performance.now()-started)}
  timings.sort((a,b)=>a-b)
  console.log(`Passed ${passed} PostgreSQL/operator/admin assertions in temporary database ${database}.`)
  console.log(`Directory + report median over 10 runs with 1,000 extra tokens and 100 extra users: ${timings[5].toFixed(1)} ms. This measures local DB/handler time, not browser or internet latency.`)
} catch (error) {
  console.error(`Check failed after ${passed} assertions: ${error.message}`)
  process.exitCode = 1
} finally {
  if(httpServer)await new Promise((resolve)=>httpServer.close(resolve))
  if(httpApp)await httpApp.locals.sessionStore.close()
  if (testPool) await testPool.end()
  if (created) {
    try { await pool.query(`DROP DATABASE "${database}"`) }
    catch (error) { console.error(`Could not remove temporary database ${database}: ${error.message}`); process.exitCode = 1 }
  }
  await pool.end()
}
