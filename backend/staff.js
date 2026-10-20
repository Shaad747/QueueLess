import { mountOperatorRoutes } from './operator.js'

// All staff access is decided by the server using current database roles.
export function mountStaffRoutes(app, pool) {
  async function requireStaff(req, res, next) {
    res.set('Cache-Control', 'no-store')
    if (!req.session.userId) {
      return res.status(401).json({ message: 'Please sign in.' })
    }
    try {
      const result = await pool.query(
        'SELECT role FROM users WHERE id = $1', [req.session.userId]
      )
      if (!result.rows.length) {
        return res.status(401).json({ message: 'Please sign in again.' })
      }
      if (!['operator', 'admin'].includes(result.rows[0].role)) {
        return res.status(403).json({ message: 'This area is for staff only.' })
      }
      next()
    } catch (error) {
      console.error('Staff authorization failed:', error.message)
      res.status(503).json({ message: 'Unable to check staff access. Please try again.' })
    }
  }

  // Repeat role + assignment checks in the data query itself. A role stored
  // in the browser or an earlier session is never used to grant access.
  const accessibleCounters = `
    SELECT c.id, c.name, c.active,
           s.id AS "serviceId", s.name AS "serviceName", s.is_open AS "serviceOpen"
    FROM counters c
    JOIN services s ON s.id = c.service_id
    JOIN users u ON u.id = $1
    WHERE (
      u.role = 'admin'
      OR (u.role = 'operator' AND EXISTS (
        SELECT 1 FROM counter_assignments ca
        WHERE ca.counter_id = c.id AND ca.operator_id = u.id
      ))
    )
  `

  app.get('/api/staff/counters', requireStaff, async (req, res) => {
    try {
      const result = await pool.query(
        accessibleCounters + ' ORDER BY s.id, c.id', [req.session.userId]
      )
      res.json({ counters: result.rows })
    } catch (error) {
      console.error('Staff counters failed:', error.message)
      res.status(500).json({ message: 'Unable to load counters.' })
    }
  })

  app.get('/api/staff/counters/:counterId', requireStaff, async (req, res) => {
    const id = Number(req.params.counterId)
    if (!/^\d+$/.test(req.params.counterId) || !Number.isSafeInteger(id) || id < 1 || id > 2147483647) {
      return res.status(400).json({ message: 'Invalid counter ID.' })
    }
    try {
      const result = await pool.query(
        accessibleCounters + ' AND c.id = $2', [req.session.userId, id]
      )
      if (!result.rows.length) {
        return res.status(404).json({ message: 'Counter not found or not assigned to you.' })
      }
      res.json({ counter: result.rows[0] })
    } catch (error) {
      console.error('Staff counter failed:', error.message)
      res.status(500).json({ message: 'Unable to load this counter.' })
    }
  })
  mountOperatorRoutes(app, pool, requireStaff)

}
