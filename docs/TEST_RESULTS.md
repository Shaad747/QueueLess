# Prepared release verification

Date: 2026-10-19. These results apply to prepared copies, before installation into the user's project.

| Check | Actual result |
|---|---|
| Vite production frontend build | Passed: 26 modules, approximately 258.50 kB JS (78.39 kB gzip), 14.73 kB CSS |
| ESLint on complete staged frontend | Passed |
| Node syntax checks on changed backend modules and installer | Passed |
| Express development and production app/router/session setup | Passed with a stub pool, without database access |
| Operator authorization and input assertions | 10 passed using a database stub |
| Admin authorization, mutation-header/origin protection and login throttling assertions | 16 passed using database stubs |
| Service worker public-only caching, offline navigation and cache cleanup | Passed using a service-worker event simulation |
| Manifest and PNG dimensions | Passed: 192×192 and 512×512 icons |
| Installer failure/rollback | Passed in a disposable directory: all original file hashes restored; all newly installed files removed |
| Live PostgreSQL SQL and concurrency checks | Not run here: tool environment denies PostgreSQL socket/shared-memory access |
| HTTP auth/session/join acceptance against temporary PostgreSQL | Supplied in release-check.mjs; pending local execution |
| Actual browser/mobile visual review and installation | Pending |
| Production hosting/TLS/cookies | Pending |

Stub checks do not prove SQL correctness or concurrent PostgreSQL behavior. Run `node release-check.mjs` locally; it creates a disposable database, tests SQL plus real local HTTP sessions/visitor joins, verifies that it is connected to the disposable database before inserting fixtures, then drops that database. It never uses a connection string that can silently override the temporary database name. Keep the printed assertion count and local timing as evidence.

The benchmark uses 100 extra users and 1,000 extra tokens. It reports local directory/report DB and handler timing, not browser roundtrip latency or 100 simultaneous clients. No unmeasured performance claim is made.
