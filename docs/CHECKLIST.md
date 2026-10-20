# Acceptance and handoff

## Existing flow

The user reported the visitor/staff/operator flow working before this update. That confirmation does not verify new release code.

## Prepared release checks

- [x] Combined frontend build and ESLint passed in a staged copy.
- [x] Backend syntax, Express router setup and security/authorization stub checks passed.
- [x] Installer failure/rollback exercise passed in a disposable folder.
- [ ] Local real PostgreSQL release-check.mjs output saved.

## Local acceptance after installation

- [ ] Visitor registration/login/logout and session restoration.
- [ ] Duplicate join returns the same active token.
- [ ] Two visitors join simultaneously and receive distinct sequential numbers.
- [ ] Two counters call different visitors; repeated request key returns its original result.
- [ ] Unassigned operator and visitor are denied staff/admin operations.
- [ ] Waiting token cancellation is permanent; rejoin issues a later number.
- [ ] Call/start/complete and call/absent update visitor status and history.
- [ ] Closed service rejects new joins/calls; current visitor can finish.
- [ ] Admin creates/edits service and counter, grants roles and changes assignments.
- [ ] Role revocation takes effect on the next API request.
- [ ] Daily report counts match direct SQL; CSV downloads correctly.
- [ ] Estimates say not enough data before 3 valid completions, then display calculated estimates.
- [ ] Disable all counters: no new calls and no estimate.
- [ ] Invalid input, duplicate names and network failures show clear messages.
- [ ] Built app works at localhost:3000 with SERVE_FRONTEND=true.

## Production and phone acceptance

- [ ] Configure hosting, PostgreSQL, HTTPS origin, secret and trusted proxy count.
- [ ] Production sign-in persists through page refresh with a secure HTTP-only cookie.
- [ ] Install on an actual iPhone; open, sign in, join, track and cancel.
- [ ] Install on actual Android; open, sign in, join, track and cancel.
- [ ] Disconnect network: show offline state and never confirm queue mutations.
- [ ] Reconnect: current server state is fetched.
- [ ] Phone and desktop sessions do not expose another account's token/history.
- [ ] Capture actual screenshots and fill in PROJECT_REPORT.md evidence.

## Submission

- [ ] Source, migrations, environment example and README.
- [ ] ER diagram and 1NF/2NF/3NF explanation (provided in PROJECT_REPORT.md).
- [ ] SQL examples, GROUP BY view, EXPLAIN and rollback output.
- [ ] Actual test/performance results and limitations.
- [ ] Screenshots, final report and demo rehearsal.

Do not describe the project as production-tested until the production/device items have been completed.
