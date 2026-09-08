#!/usr/bin/env bash
#
# Seeds the demo dataset into a REMOTE database, additively.
#
# Additive: prisma/seed-demo.ts deletes nothing and skips any company already
# present, so a second run is a no-op rather than a duplicate. Whatever is already
# in the target — users, employees, audit trail — is left alone.
#
#   ./scripts/seed-remote-demo.sh                       # uses .env.production.local
#   ./scripts/seed-remote-demo.sh .env.staging.local    # or a file you name
#
# The database URL is read from that env file and never printed or passed on the
# command line. The seed itself refuses any non-local host unless the host is named
# back to it, so a mistyped env file cannot quietly seed the wrong database.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

ENV_FILE="${1:-.env.production.local}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "No such env file: $ENV_FILE" >&2
  exit 1
fi

# ── Resolve the target ────────────────────────────────────────────────────────
# Parsed by node so the URL itself never reaches the terminal or the shell history.
# Errors deliberately report nothing but the fact of the failure: node's own URL
# parse error quotes the string it was given, which for a real env file means
# printing the database password to the terminal and into scrollback.
HOST="$(node -e "
  const dotenv = require('dotenv');
  // Expanded, because an env file may compose the URL from other variables in it
  // (the local .env does) and the raw value would then be a template, not a URL.
  require('dotenv-expand').expand(dotenv.config({ path: '$ENV_FILE' }));
  const u = process.env.DATABASE_URL;
  if (!u) { console.error('DATABASE_URL is not set in $ENV_FILE'); process.exit(1); }
  try {
    process.stdout.write(new URL(u).hostname);
  } catch {
    console.error('DATABASE_URL in $ENV_FILE is not a parseable URL.');
    process.exit(1);
  }
")"

if [[ "$HOST" == "localhost" || "$HOST" == "127.0.0.1" || "$HOST" == "::1" ]]; then
  echo "$ENV_FILE points at $HOST — that is your local database." >&2
  echo "For local seeding use:  npm run db:demo" >&2
  exit 1
fi

# ── Confirm the schema is current ─────────────────────────────────────────────
# A target behind on migrations fails part-way through the seed with an error about
# a missing column, which reads as a broken script rather than a pending deploy.
echo
echo "Checking migrations on $HOST ..."
if ! DOTENV_CONFIG_PATH="$ENV_FILE" node -r dotenv/config \
      ./node_modules/.bin/prisma migrate status 2>&1 | grep -q "up to date"; then
  echo
  echo "That database is NOT up to date with prisma/migrations." >&2
  echo "Deploy migrations first, then re-run this script:" >&2
  echo "  DOTENV_CONFIG_PATH=$ENV_FILE node -r dotenv/config ./node_modules/.bin/prisma migrate deploy" >&2
  exit 1
fi
echo "Schema is up to date."

# ── Census before ─────────────────────────────────────────────────────────────
census() {
  DOTENV_CONFIG_PATH="$ENV_FILE" node -r dotenv/config -e "
    const { PrismaClient } = require('@prisma/client');
    const p = new PrismaClient();
    (async () => {
      await p.\$executeRawUnsafe(\"SELECT set_config('app.is_super_admin','true',false)\");
      const of = async (m) => { try { return await p[m].count(); } catch { return 0; } };
      const parts = [
        ['companies', await of('company')],
        ['users', await of('user')],
        ['employees', await of('employee')],
        ['punches', await of('punchRecord')],
        ['purchases', await of('purchase')],
        ['candidates', await of('candidate')],
      ];
      console.log('    ' + parts.map(([k, v]) => k + '=' + v).join('  '));
      await p.\$disconnect();
    })();
  "
}

echo
echo "Current contents of $HOST:"
census

# ── Confirm ───────────────────────────────────────────────────────────────────
cat <<BANNER

────────────────────────────────────────────────────────────────────────────
  About to seed the demo dataset into:

      $HOST

  This ADDS two companies (PRPL, SBPL) with ~19 employees, ~900 punches,
  inventory movements, plant logbook and maintenance, and a recruitment
  pipeline. It DELETES NOTHING — anything already there is left as it is.

  All 19 seeded logins use the password  secret42, and admin@buildcore.dev
  is created as a cross-company Super Admin.

  Letters are skipped: their PDFs live in the deployment's object storage,
  under a key this script does not hold.

  Take a Neon branch first if you have not. Deleting the companies later
  will NOT undo this — most tables hold companyId as a plain string with no
  foreign key, so their rows would be orphaned rather than removed.
────────────────────────────────────────────────────────────────────────────

BANNER

read -r -p "Type the host to confirm, or anything else to abort: " CONFIRM
if [[ "$CONFIRM" != "$HOST" ]]; then
  echo "Aborted. Nothing was written."
  exit 1
fi

# ── Seed ──────────────────────────────────────────────────────────────────────
# SEED_DEMO_ALLOW_HOST is the seed's own opt-in; it refuses a remote host without it.
echo
echo "Seeding — expect a few minutes; every insert is a round trip."
echo

DOTENV_CONFIG_PATH="$ENV_FILE" \
SEED_DEMO_ALLOW_HOST="$HOST" \
npx ts-node prisma/seed-demo.ts

# ── Census after ──────────────────────────────────────────────────────────────
echo
echo "Contents of $HOST now:"
census

cat <<DONE

Done. To confirm it is idempotent, run this script again — it should report
both companies "already present — skipped" and write nothing.

Sign in at your deployed app as:
    rajesh.kulkarni@parthrealcon.com   / secret42   (Site Admin, Parth Realcon)
    amit.deshpande@shreejibuildtech.in / secret42   (Site Admin, Shreeji Buildtech)
    admin@buildcore.dev                / secret42   (Super Admin, both)

DONE
