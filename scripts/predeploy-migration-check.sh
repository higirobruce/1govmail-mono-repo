#!/usr/bin/env bash
# Pre-deploy migration-history check for 1Gov Mail environments.
#
# Guards against the known wedge: migration 20260901090153_add_sender_rules also
# creates five tables that DBs restored from pre-September dumps already have
# (audit_logs, doc_comments, doc_comment_reactions, doc_versions, doc_activity).
# Running `prisma migrate deploy` against such a DB fails with "relation already
# exists" and wedges the migration history.
#
# Usage (on the target host, e.g. a VM):
#   set -a; source /opt/govmail/api.env; set +a
#   bash predeploy-migration-check.sh
#
# The embedded PG has no psql client, so this uses the pg module bundled with the
# API. Override API_DIR if the app lives elsewhere (default /opt/govmail/api).
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL not set — source the api env file first}"
API_DIR="${API_DIR:-/opt/govmail/api}"

cd "$API_DIR"
node - <<'EOF'
const { Client } = require('pg');
const MIGRATION = '20260901090153_add_sender_rules';
const TABLES = ['audit_logs', 'doc_comments', 'doc_comment_reactions', 'doc_versions', 'doc_activity'];

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const existing = (await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)`,
      [TABLES],
    )).rows.map(r => r.tablename);

    let applied = false;
    try {
      applied = (await client.query(
        `SELECT 1 FROM _prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`,
        [MIGRATION],
      )).rowCount > 0;
    } catch {
      console.log('NOTE: no _prisma_migrations table — fresh DB, nothing to resolve.');
    }

    const pending = (await client.query(
      `SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL`,
    ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;

    console.log(`Tables already present: ${existing.length ? existing.join(', ') : '(none)'}`);
    console.log(`${MIGRATION} recorded as applied: ${applied}`);
    if (pending > 0) console.log(`WARNING: ${pending} unfinished migration row(s) — history may already be wedged.`);

    if (existing.length > 0 && !applied) {
      console.log('\n*** COLLISION: pre-existing tables + migration not recorded. ***');
      console.log('Do NOT run `prisma migrate deploy` yet. Verify column parity, then:');
      console.log(`  npx prisma migrate resolve --applied ${MIGRATION}`);
      process.exit(2);
    }
    console.log('\nOK: safe to run `prisma migrate deploy`.');
  } finally {
    await client.end();
  }
})().catch(e => { console.error('Check failed:', e.message); process.exit(1); });
EOF
