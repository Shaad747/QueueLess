// Local provisioning tool. Run from backend, where db.js loads .env.
// Only someone with local database access can run these administrative commands.
import pool from './db.js'

const [command, rawEmail, value, ...extra] = process.argv.slice(2)
const email = rawEmail?.trim().toLowerCase()
const usage = `Usage:
  node staff-admin.mjs list
  node staff-admin.mjs role EMAIL visitor|operator|admin
  node staff-admin.mjs assign EMAIL COUNTER_ID
  node staff-admin.mjs revoke EMAIL COUNTER_ID
Users must register through QueueLess before receiving a role.`
let client
try {
  if (extra.length || !['list', 'role', 'assign', 'revoke'].includes(command)) throw new Error(usage)
  if (command === 'list') {
    if (rawEmail || value) throw new Error(usage)
    const result = await pool.query(`
      SELECT c.id AS counter_id, s.name AS service, c.name AS counter, c.active,
        COALESCE(string_agg(u.email, ', ' ORDER BY u.email), '') AS assigned_operators
      FROM counters c JOIN services s ON s.id = c.service_id
      LEFT JOIN counter_assignments a ON a.counter_id = c.id
      LEFT JOIN users u ON u.id = a.operator_id AND u.role = 'operator'
      GROUP BY c.id, s.name ORDER BY c.id
    `)
    console.table(result.rows)
  } else {
    if (!email || !value) throw new Error(usage)
    if (command === 'role' && !['visitor', 'operator', 'admin'].includes(value)) throw new Error(usage)
    const counterId = Number(value)
    if (command !== 'role' && (!/^\d+$/.test(value) || !Number.isSafeInteger(counterId) || counterId < 1 || counterId > 2147483647)) {
      throw new Error('Counter ID must be a positive integer.')
    }
    client = await pool.connect()
    await client.query('BEGIN')
    // Serialize changes from this tool, including the last-admin check.
    await client.query('SELECT pg_advisory_xact_lock(74129, 1)')
    const found = await client.query(
      'SELECT id, email, role FROM users WHERE lower(trim(email)) = $1 FOR UPDATE', [email]
    )
    const user = found.rows[0]
    if (!user) throw new Error('No registered account has that email. Register it on the website first.')
    if (command === 'role') {
      if (user.role === 'admin' && value !== 'admin') {
        const others = await client.query("SELECT id FROM users WHERE role = 'admin' AND id <> $1", [user.id])
        if (!others.rows.length) throw new Error('Cannot remove the last admin. Promote another admin first.')
      }
      await client.query('UPDATE users SET role = $1 WHERE id = $2', [value, user.id])
      if (value !== 'operator') {
        await client.query('DELETE FROM counter_assignments WHERE operator_id = $1', [user.id])
      }
      await client.query('COMMIT')
      console.log(`${user.email} now has role: ${value}. Sign out and back in to refresh the navigation.`)
    } else {
      const counter = await client.query('SELECT id, active FROM counters WHERE id = $1 FOR UPDATE', [counterId])
      if (!counter.rows.length) throw new Error('Counter does not exist. Run the list command to see IDs.')
      if (command === 'assign') {
        if (user.role !== 'operator') throw new Error('Only operators need counter assignments. Set the operator role first. Admins can access all counters.')
        if (!counter.rows[0].active) throw new Error('Cannot assign an inactive counter.')
        await client.query('INSERT INTO counter_assignments(counter_id, operator_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [counterId, user.id])
      } else {
        await client.query('DELETE FROM counter_assignments WHERE counter_id = $1 AND operator_id = $2', [counterId, user.id])
      }
      await client.query('COMMIT')
      console.log(`${command === 'assign' ? 'Assigned' : 'Revoked'} counter ${counterId} for ${user.email}.`)
    }
  }
} catch (error) {
  if (client) await client.query('ROLLBACK').catch(() => {})
  console.error(error.message)
  process.exitCode = 1
} finally {
  client?.release()
  await pool.end()
}
