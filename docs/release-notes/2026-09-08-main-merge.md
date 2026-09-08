# Release notes — ft-hyperscale → main merge (2026-09-08)

PR #2 merged at `45b4711` (335 commits). Both test VMs (.154 / .155) already run this code
(api `032524c` + web `a4b969c`); these notes matter for any **new or lagging** environment.

## User-facing changes to announce

### Sessions & device management
- **One-time global sign-out on deploy.** Session validation is now live against the DB;
  JWTs issued before the deploy have no session row and are rejected. Every logged-in user
  signs in again once. This is expected, not an incident.
- **Session length is now bounded by the Zimbra token lifetime** (typically 12–24h),
  not the old 7-day JWT. Docs, Tasks, Notifications and Settings previously stayed usable
  for a week after login; they now expire with the Zimbra token. Users on long-lived
  devices will see more frequent re-logins.
- New Settings → Security panel: list devices, revoke one, revoke all others. Revocation
  also disconnects live doc-collaboration sockets.

### Blocked & allowed senders
- Blocked senders are auto-filed to Junk on Inbox sync. Enforcement is Inbox-scoped by
  design (it does not retroactively sweep other folders).

## Operator notes

### Migration pre-check (required on any DB restored from a pre-September dump)
`20260901090153_add_sender_rules` also creates five tables (`audit_logs`, `doc_comments`,
`doc_comment_reactions`, `doc_versions`, `doc_activity`) that older DBs already have.
Running `prisma migrate deploy` against such a DB fails with "relation already exists"
and wedges the migration history.

Run `scripts/predeploy-migration-check.sh` on the target host **before** `migrate deploy`.
If it reports the collision: verify column parity, then
`npx prisma migrate resolve --applied 20260901090153_add_sender_rules` and re-run deploy.
(Both test VMs have already been resolved this way.)

### Other operational facts
- pgvector HNSW indices are hand-authored migrations — never let Prisma drift-detection
  drop them.
- On a fresh embedded-PG restore, re-apply the `trusted = true` edit to `vector.control`
  before migrating, or `add_message_embeddings` wedges.
- The api tarball is VM-portable; the web tarball bakes per-host URLs — always rebuild
  web per target (`scripts/build-web-154.sh` / `build-web-155.sh`).
- Desktop `apps/desktop/api-bundle` is stale (7 of 15 modules) — regenerate before any
  desktop release.

## Addendum — AI personalization P1+P2 (2026-09-08 pm)

- **Custom AI instructions now live on the account, not the device.** Existing device-local
  instructions migrate up automatically the first time that device syncs (one-time, per-user-keyed —
  a device previously used by someone else never migrates their text into your account). Other
  devices pick up the account value on next load.
- New Settings → **AI Profile** section (visible even on builds with the AI model locked): job
  title, institution, department, preferred language, and the instructions editor (moved here from
  the AI Assistant section). "Suggest from directory" pre-fills blank fields from the Zimbra GAL.
- AI answers and drafts now know who they're written for/as, tiered per surface: the agent and Ask
  see the full profile; meeting prep sees the identity card; dossiers see the identity line only;
  summaries/cards see nothing. Deploy requires migration `add_user_ai_profiles` (one pending per VM).
