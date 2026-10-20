import { loadEnvFile } from 'node:process'
import { existsSync } from 'node:fs'
import pg from 'pg'
if (existsSync('.env')) loadEnvFile()
const timezone = process.env.APP_TIMEZONE || 'Asia/Kolkata'
if (!/^[A-Za-z0-9_+\/-]+$/.test(timezone)) throw new Error('Invalid APP_TIMEZONE')
new Intl.DateTimeFormat('en-US',{ timeZone:timezone })
const pool = new pg.Pool({
  ...(process.env.DATABASE_URL ? { connectionString:process.env.DATABASE_URL } : {}),
  connectionTimeoutMillis:5000,
  max:10,
  options:`-c timezone=${timezone}`,
})
pool.on('error',(error) => console.error('Unexpected database connection error:',error.message))
export default pool
