import { createHmac } from 'node:crypto'

export function installSecurity(app, pool, production) {
  app.disable('x-powered-by')
  const configuredOrigin = process.env.APP_ORIGIN ? new URL(process.env.APP_ORIGIN).origin : null
  if (production && (!configuredOrigin || !configuredOrigin.startsWith('https://'))) throw new Error('Production requires APP_ORIGIN=https://your-domain')
  const proxyHops = Number(process.env.TRUST_PROXY_HOPS || 0)
  if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 5) throw new Error('TRUST_PROXY_HOPS must be 0–5')
  if (proxyHops) app.set('trust proxy', proxyHops)
  let cleanupAfter = 0
  app.use(async (req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff')
    res.set('Referrer-Policy', 'same-origin')
    res.set('X-Frame-Options', 'DENY')
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    if (req.path.startsWith('/api/')) res.set('Cache-Control','no-store')
    if (production) {
      res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'")
      if (req.secure) res.set('Strict-Transport-Security','max-age=31536000')
    }
    if (['POST','PUT','PATCH','DELETE'].includes(req.method) && req.path.startsWith('/api/')) {
      const origin = req.get('Origin')
      const allowed = new Set(production ? [configuredOrigin] : ['http://localhost:5173','http://127.0.0.1:5173',`http://${req.get('host')}`])
      if (!req.get('X-QueueLess-Request') || !req.is('application/json') || req.get('Sec-Fetch-Site') === 'cross-site' || (origin && !allowed.has(origin))) {
        return res.status(403).json({ message:'Please submit this request from QueueLess.' })
      }
    }
    if (req.method !== 'POST' || !['/api/auth/login','/api/auth/register'].includes(req.path)) return next()
    try {
      const key = (raw) => createHmac('sha256', process.env.SESSION_SECRET).update(raw).digest('hex')
      const registering = req.path.endsWith('/register')
      const seconds = registering ? 3600 : 900
      const limits = [[key(`${req.path}:ip:${req.ip}`), registering ? 10 : 50]]
      if (!registering && typeof req.body?.email === 'string') limits.push([key(`login:email:${req.body.email.trim().toLowerCase()}`),15])
      for (const [bucket, limit] of limits) {
        const result = await pool.query(`INSERT INTO auth_limits(bucket,bucket_start) VALUES ($1,to_timestamp(floor(EXTRACT(EPOCH FROM NOW())/$2)*$2))
          ON CONFLICT(bucket,bucket_start) DO UPDATE SET attempts=auth_limits.attempts+1 RETURNING attempts`,[bucket,seconds])
        if (result.rows[0].attempts > limit) {
          res.set('Retry-After',String(seconds))
          return res.status(429).json({ message: 'Too many attempts. Please wait before trying again.' })
        }
      }
      if (Date.now() > cleanupAfter) {
        cleanupAfter = Date.now()+3600000
        await pool.query("DELETE FROM auth_limits WHERE bucket_start < NOW()-INTERVAL '2 hours'")
      }
      next()
    } catch (error) { console.error('Authentication limiter failed:',error.message); res.status(503).json({message:'Sign-in is temporarily unavailable. Please try again.'}) }
  })
}
