import { readFile } from 'node:fs/promises'
import pool from './db.js'
let client
try {
  client=await pool.connect()
  await client.query('SELECT pg_advisory_lock(74129,3)')
  const migrations=[['services','schema.sql'],['users','002_users.sql'],['queue_tokens','003_queue_tokens.sql'],['counters','004_staff_permissions.sql'],['service_visits','005_operator_workflow.sql']]
  for(const [table,file] of migrations){
    const exists=(await client.query('SELECT to_regclass($1) AS name',[`public.${table}`])).rows[0].name
    if(!exists){await client.query(await readFile(new URL(file,import.meta.url),'utf8'));console.log(`Applied ${file}`)}
  }
  await client.query('CREATE TABLE IF NOT EXISTS app_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())')
  if(!(await client.query("SELECT version FROM app_migrations WHERE version='006'")).rows.length){
    await client.query(await readFile(new URL('006_admin_reports.sql',import.meta.url),'utf8'))
    await client.query("INSERT INTO app_migrations(version) VALUES ('006') ON CONFLICT DO NOTHING")
    console.log('Applied 006_admin_reports.sql')
  }
  console.log('Database migrations complete.')
} catch(error){console.error('Migration failed:',error.message || error.code || 'Database connection failed. Check Postgres.app and your database environment settings.');process.exitCode=1}
finally{if(client){await client.query('SELECT pg_advisory_unlock(74129,3)').catch(()=>{});client.release()}await pool.end()}
