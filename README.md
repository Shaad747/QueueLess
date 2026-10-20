# QueueLess

A campus queue application built with React, Node.js/Express and PostgreSQL. Visitors join and track queues; operators handle assigned counters; administrators manage services, counters, roles, assignments and daily reports. The built app includes a manifest, home-screen icons and a public offline page for installation on iPhone and Android.

## Install this update into the existing project

1. In VS Code, press Control+C in the backend terminal, then Control+C in the frontend terminal.
2. In either stopped terminal run:

```bash
node /Users/shaad/Documents/Codex/2026-10-17/ex/queueless-release/install.mjs
```

The installer checks for unexpected source changes, backs up replaced files under `.queueless-backups/`, preserves `.env`, runs the additive migration and builds the frontend. No npm dependency installation is needed for this update. On failure it restores previous source files. If it reports a changed source file, stop and share that message rather than forcing replacement.

3. In the backend terminal:

```bash
cd ~/Documents/QueueLess/backend
node release-check.mjs
npm run dev
```

The check uses a separate temporary database and removes it afterward. It tests real SQL, permissions, concurrent calls, retries, admin operations, reporting and estimate rules. It also prints a local directory/report timing using 100 extra users and 1,000 tokens in that temporary database. It requires PostgreSQL CREATE DATABASE permission. Stop and share any error before starting the backend.

4. In the frontend terminal:

```bash
cd ~/Documents/QueueLess/frontend
npm run dev
```

5. Open http://localhost:5173 and sign in with your existing accounts. An admin sees **Admin** in the navigation. An operator sees **Staff access**. If a role was just changed, sign out and back in.

## New admin workspace

- Services: create/edit names, descriptions and display hours; open/close queues.
- Counters: create/rename/enable/disable counters and remove assignments.
- People: find an exact registered email, change role, and assign an operator to an enabled counter. Use another admin to change your own admin role. The last admin is protected.
- Reports: filter queue date and service; view volume, status counts, average/median queue wait, mean service duration and absent percentage; download CSV.

Opening hours are informative text. The explicit open/closed switch controls admission. Deactivation preserves history. Admin and operator API permissions are enforced by PostgreSQL-backed role checks, regardless of visible navigation. Role changes revoke access on the next request.

## Estimates

Service cards and waiting tokens use the last 20 completed service durations from seven days, requiring at least three valid samples and an enabled counter. Durations outside (0, 4 hours] are excluded. Capacity is the count of enabled counters, not a guarantee that staff are available. Estimates are approximate and are never appointments. Very short demo visits can produce tiny estimates; real usage produces more representative samples. Queue order is always FIFO.

## Run the built app locally

This checks the same compiled frontend that will be deployed and enables the production service worker on localhost. Stop both dev servers first. In the frontend terminal:

```bash
cd ~/Documents/QueueLess/frontend
npm run build
```

In the backend terminal:

```bash
cd ~/Documents/QueueLess/backend
SERVE_FRONTEND=true npm start
```

Open http://localhost:3000. This mode keeps development cookies usable on local HTTP. Production uses `NODE_ENV=production`, secure cookies and an HTTPS origin instead.

The service worker caches only public offline/help assets. API responses, accounts, tokens and reports are never cached. Offline queue changes are not supported; the offline page asks the user to reconnect.

## Phone installation

Use a publicly reachable HTTPS deployment. A phone's localhost refers to the phone itself, so the Mac's localhost link will not open the project on a phone.

- iPhone: open the deployed URL in Safari → Share → Add to Home Screen.
- Android: open it in Chrome → browser menu → Install app / Add to Home screen. A page install button appears when the browser exposes its install prompt.

Installation behavior depends on the browser. Verify installation, sign-in, a join and live token updates on both an actual iPhone and Android device. These device checks and app-store distribution have not been performed. This is a web app installed from the browser; app-store packaging would be a separate publishing process.

## Fresh setup / handoff

Requirements: Node.js 24, npm, PostgreSQL 18 (or compatible), and a local database named `queueless`.

```bash
cd backend
npm ci
cp .env.example .env
```

Edit `.env` for your database user and generate your session secret locally:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Put the result in `SESSION_SECRET`. Do not commit `.env`. Then:

```bash
npm run migrate
npm run dev
```

In a second terminal:

```bash
cd frontend
npm ci
npm run dev
```

Register distinct visitor, operator and admin accounts through the site. Bootstrap only the first admin locally:

```bash
cd backend
node staff-admin.mjs role admin@example.com admin
```

Use the actual email you registered. The admin can grant other roles and assignments through the site. Public registration always creates visitors. No shared demo password is installed.

## Deploy as one service

A single Express service serves both `/api` and the compiled React frontend. This keeps sessions and cookies on one origin. PostgreSQL stays in its own managed database or server.

The included Dockerfile builds frontend assets and starts the API after migrations. A hosting provider must supply PostgreSQL access and HTTPS. Configure environment variables rather than copying local `.env` to hosting:

- `DATABASE_URL`: provider-issued PostgreSQL connection URL, using its required TLS/certificate settings.
- `SESSION_SECRET`: a fresh random secret of at least 32 characters.
- `NODE_ENV=production`.
- `APP_ORIGIN=https://your-actual-hostname`.
- `APP_TIMEZONE=Asia/Kolkata` (or your campus timezone).
- `TRUST_PROXY_HOPS`: correct trusted proxy hop count for your host; use `1` only when there is exactly one trusted reverse proxy.
- `PORT`: supplied by hosting if required; default 3000.

A production origin without HTTPS is rejected. Secure session cookies need the proxy configuration to reflect the actual hosting topology. The database connection uses provider TLS settings; certificate verification is not disabled by this code. Local database contents are not uploaded automatically. Create/migrate the production database and bootstrap its admin separately.

Hosting has not been purchased or configured, and nothing was published. Deployment still needs a provider/account, environment setup and a live acceptance check.

## Verification and remaining handoff

Prepared-source checks and local database checks have different evidence. See `docs/CHECKLIST.md` and `docs/PROJECT_REPORT.md` for the honest status record. Keep actual test output and device results when you run them. Complete screenshots, actual performance measurements and a final demo before submission.

References: [PWA installation requirements](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable), [Express production security](https://expressjs.com/en/advanced/best-practice-security/), [Express proxy configuration](https://expressjs.com/en/guide/behind-proxies/).
## Project team

- [Ariyaan-Sadiq](https://github.com/Ariyaan-Sadiq)
