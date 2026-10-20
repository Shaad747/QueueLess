const validId = (x) => /^\d+$/.test(String(x)) && Number.isSafeInteger(Number(x)) && Number(x) > 0 && Number(x) <= 2147483647
class AdminError extends Error { constructor(status, message) { super(message); this.status = status } }
const text = (value, max, name) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new AdminError(400, `${name} is required (maximum ${max} characters).`)
  return value.trim()
}
const flag = (value) => { if (typeof value !== 'boolean') throw new AdminError(400, 'An open/enabled choice is required.'); return value }
const identifier = (value) => { if (!validId(value)) throw new AdminError(400, 'Invalid record ID.'); return Number(value) }

export function mountAdminRoutes(app, pool) {
  async function requireAdmin(req, res, next) {
    res.set('Cache-Control', 'no-store')
    if (!req.session.userId) return res.status(401).json({ message: 'Please sign in.' })
    try {
      const row = (await pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId])).rows[0]
      if (row?.role !== 'admin') return res.status(403).json({ message: 'Administrator access is required.' })
      next()
    } catch (error) { console.error('Admin access failed:', error.message); res.status(503).json({ message: 'Unable to check admin access.' }) }
  }
  function fail(res, error) {
    if (error.code === '23505') return res.status(409).json({ message: 'That name already exists. Use a different name.' })
    if (!error.status) console.error('Admin operation failed:', error.message)
    return res.status(error.status || 500).json({ message: error.status ? error.message : 'Unable to complete the admin operation.' })
  }
  async function edit(req, res, action, work) {
    let client
    try {
      if (req.get('X-QueueLess-Action') !== 'admin' || !req.is('application/json') || req.get('Sec-Fetch-Site') === 'cross-site') throw new AdminError(403, 'Submit changes from the admin workspace.')
      client = await pool.connect()
      await client.query('BEGIN')
      // Same lock as staff-admin.mjs: serializes role and assignment administration.
      await client.query('SELECT pg_advisory_xact_lock(74129, 1)')
      const actor = (await client.query('SELECT role FROM users WHERE id = $1 FOR SHARE', [req.session.userId])).rows[0]
      if (actor?.role !== 'admin') throw new AdminError(403, 'Administrator access is required.')
      const result = await work(client)
      await client.query('INSERT INTO admin_events(actor_id,action,entity_id,details) VALUES ($1,$2,$3,$4)', [req.session.userId, action, result.entityId, JSON.stringify(result.details || {})])
      await client.query('COMMIT')
      res.json(result)
    } catch (error) { if (client) await client.query('ROLLBACK').catch(() => {}); fail(res, error) }
    finally { client?.release() }
  }
  function reportFilters(req) {
    const date = req.query.date
    if (date !== undefined) {
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) !== date || date < '2000-01-01' || date > '2100-12-31') throw new AdminError(400, 'Choose a valid report date between 2000 and 2100.')
    }
    const serviceId = req.query.serviceId === undefined || req.query.serviceId === '' ? null : identifier(req.query.serviceId)
    return [date || null, serviceId]
  }
  const reportSql = `
    SELECT s.id AS "serviceId", s.name AS "serviceName", COALESCE($1::date,CURRENT_DATE)::text AS date,
      COALESCE(r.tokens,0) AS tokens, COALESCE(r.waiting,0) AS waiting,
      COALESCE(r.in_progress,0) AS "inProgress", COALESCE(r.completed,0) AS completed,
      COALESCE(r.cancelled,0) AS cancelled, COALESCE(r.no_shows,0) AS "noShows",
      ROUND(r.average_wait_minutes::numeric,2)::float AS "averageWait",
      ROUND(r.median_wait_minutes::numeric,2)::float AS "medianWait",
      ROUND(r.mean_service_minutes::numeric,2)::float AS "meanService",
      CASE WHEN COALESCE(r.completed,0)+COALESCE(r.no_shows,0) > 0
        THEN ROUND(100.0*r.no_shows/(r.completed+r.no_shows),1)::float ELSE NULL END AS "noShowPercent"
    FROM services s LEFT JOIN daily_service_report r ON r.service_id = s.id AND r.service_date = COALESCE($1::date,CURRENT_DATE)
    WHERE ($2::integer IS NULL OR s.id=$2) ORDER BY s.id
  `
  app.get('/api/admin/overview', requireAdmin, async (req, res) => {
    try {
      const services = (await pool.query('SELECT id,name,description,opening_hours AS hours,is_open AS "isOpen" FROM services ORDER BY id')).rows
      const counters = (await pool.query('SELECT c.id,c.service_id AS "serviceId",s.name AS "serviceName",c.name,c.active FROM counters c JOIN services s ON s.id=c.service_id ORDER BY c.id')).rows
      const assignments = (await pool.query(`SELECT a.counter_id AS "counterId",u.id AS "operatorId",u.name,u.email FROM counter_assignments a JOIN users u ON u.id=a.operator_id WHERE u.role='operator' ORDER BY a.counter_id,u.id`)).rows
      const today = (await pool.query('SELECT CURRENT_DATE::text AS today')).rows[0].today
      res.json({ services, counters, assignments, today })
    } catch (error) { fail(res, error) }
  })
  app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
      const email = text(req.query.email, 254, 'Email').toLowerCase()
      const users = (await pool.query('SELECT id,name,email,role FROM users WHERE lower(trim(email))=$1 LIMIT 1', [email])).rows
      res.json({ users })
    } catch (error) { fail(res, error) }
  })
  app.get('/api/admin/reports', requireAdmin, async (req, res) => {
    try { res.json({ reports: (await pool.query(reportSql, reportFilters(req))).rows }) }
    catch (error) { fail(res, error) }
  })
  app.get('/api/admin/reports.csv', requireAdmin, async (req, res) => {
    try {
      const rows = (await pool.query(reportSql, reportFilters(req))).rows
      const columns = ['date','serviceName','tokens','waiting','inProgress','completed','cancelled','noShows','averageWait','medianWait','meanService','noShowPercent']
      const quote = (value) => { let s = value == null ? '' : String(value); if (/^[\s]*[=+@-]/.test(s)) s = `'${s}`; return `"${s.replaceAll('"','""')}"` }
      const csv = [columns.map(quote).join(','), ...rows.map((row) => columns.map((key) => quote(row[key])).join(','))].join('\r\n')
      res.set('Content-Type','text/csv; charset=utf-8').set('Content-Disposition','attachment; filename="queueless-report.csv"').send('\uFEFF'+csv)
    } catch (error) { fail(res, error) }
  })
  app.post('/api/admin/services', requireAdmin, (req,res) => edit(req,res,'SERVICE_CREATED',async (client) => {
    const { name,description,hours,isOpen } = req.body || {}
    const row = (await client.query('INSERT INTO services(name,description,opening_hours,is_open) VALUES ($1,$2,$3,$4) RETURNING id', [text(name,100,'Name'),text(description,500,'Description'),text(hours,100,'Hours'),flag(isOpen)])).rows[0]
    return { entityId: row.id, message: 'Service created.' }
  }))
  app.put('/api/admin/services/:id', requireAdmin, (req,res) => edit(req,res,'SERVICE_UPDATED',async (client) => {
    const id = identifier(req.params.id)
    const { name,description,hours,isOpen } = req.body || {}
    const result = await client.query('UPDATE services SET name=$1,description=$2,opening_hours=$3,is_open=$4,business_date=CURRENT_DATE WHERE id=$5 RETURNING id', [text(name,100,'Name'),text(description,500,'Description'),text(hours,100,'Hours'),flag(isOpen),id])
    if (!result.rows.length) throw new AdminError(404,'Service not found.')
    return { entityId:id, message:'Service saved.', details:{ isOpen } }
  }))
  app.post('/api/admin/counters', requireAdmin, (req,res) => edit(req,res,'COUNTER_CREATED',async (client) => {
    const { serviceId,name,active } = req.body || {}
    const id = identifier(serviceId)
    const service = await client.query('SELECT id FROM services WHERE id=$1 FOR UPDATE',[id])
    if (!service.rows.length) throw new AdminError(404,'Service not found.')
    const row = (await client.query('INSERT INTO counters(service_id,name,active) VALUES ($1,$2,$3) RETURNING id',[id,text(name,100,'Counter name'),flag(active)])).rows[0]
    return { entityId:row.id,message:'Counter created.' }
  }))
  app.put('/api/admin/counters/:id', requireAdmin, (req,res) => edit(req,res,'COUNTER_UPDATED',async (client) => {
    const id = identifier(req.params.id)
    const { name,active } = req.body || {}
    const initial = (await client.query('SELECT service_id FROM counters WHERE id=$1',[id])).rows[0]
    if (!initial) throw new AdminError(404,'Counter not found.')
    await client.query('SELECT id FROM services WHERE id=$1 FOR UPDATE',[initial.service_id])
    await client.query('UPDATE counters SET name=$1,active=$2 WHERE id=$3',[text(name,100,'Counter name'),flag(active),id])
    return { entityId:id,message:'Counter saved.',details:{ active } }
  }))
  app.put('/api/admin/users/:id/role', requireAdmin, (req,res) => edit(req,res,'ROLE_UPDATED',async (client) => {
    const id = identifier(req.params.id)
    const role = req.body?.role
    if (!['visitor','operator','admin'].includes(role)) throw new AdminError(400,'Choose a valid role.')
    if (id === req.session.userId && role !== 'admin') throw new AdminError(409,'Use another admin account to change your own admin role.')
    const target = (await client.query('SELECT role FROM users WHERE id=$1 FOR UPDATE',[id])).rows[0]
    if (!target) throw new AdminError(404,'Account not found.')
    if (target.role === 'admin' && role !== 'admin') {
      const others = await client.query("SELECT id FROM users WHERE role='admin' AND id<>$1",[id])
      if (!others.rows.length) throw new AdminError(409,'The last administrator cannot be removed.')
    }
    await client.query('UPDATE users SET role=$1 WHERE id=$2',[role,id])
    if (role !== 'operator') await client.query('DELETE FROM counter_assignments WHERE operator_id=$1',[id])
    return { entityId:id,message:'Role updated. The user should sign out and back in.',details:{ role } }
  }))
  app.put('/api/admin/assignments', requireAdmin, (req,res) => edit(req,res,'ASSIGNMENT_UPDATED',async (client) => {
    const operatorId = identifier(req.body?.operatorId)
    const counterId = identifier(req.body?.counterId)
    const assigned = flag(req.body?.assigned)
    const user = (await client.query('SELECT role FROM users WHERE id=$1 FOR UPDATE',[operatorId])).rows[0]
    if (!user || user.role !== 'operator') throw new AdminError(409,'Choose an account with the operator role.')
    const initial = (await client.query('SELECT service_id FROM counters WHERE id=$1',[counterId])).rows[0]
    if (!initial) throw new AdminError(404,'Counter not found.')
    await client.query('SELECT id FROM services WHERE id=$1 FOR UPDATE',[initial.service_id])
    const counter = (await client.query('SELECT active FROM counters WHERE id=$1 FOR UPDATE',[counterId])).rows[0]
    if (assigned && !counter.active) throw new AdminError(409,'Enable the counter before assigning it.')
    if (assigned) await client.query('INSERT INTO counter_assignments(counter_id,operator_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[counterId,operatorId])
    else await client.query('DELETE FROM counter_assignments WHERE counter_id=$1 AND operator_id=$2',[counterId,operatorId])
    return { entityId:counterId,message: assigned ? 'Operator assigned.' : 'Assignment removed.',details:{ operatorId,assigned } }
  }))
}
