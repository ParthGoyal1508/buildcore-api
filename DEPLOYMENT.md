# Backend Deployment Checklist — buildcore-api

Stack: NestJS + Prisma + PostgreSQL, Dockerized (`Dockerfile` / `Dockerfile.alpine` present).
Goal: free tier wherever possible.

## 1. Pick a hosting platform

- [ ] **Render (free Web Service)** — recommended for simplicity. Docker-native (uses your existing `Dockerfile`), auto-deploys from GitHub, free SSL/domain. Downside: free instance spins down after ~15 min idle → ~30–50s cold start on the next request.
- [ ] **Google Cloud Run** — alternative if you're OK with `gcloud`/GCP console setup. Genuinely always-free tier (2M requests/month, generous CPU/memory-seconds), Docker-native, scales to zero. Better free-tier ceiling than Render but more setup.
- [ ] ~~Railway~~ / ~~Fly.io~~ — skip: Railway dropped its free tier (trial credit only now); Fly.io removed free allowances for new accounts (small paid minimum).

> Decision: ______________

## 2. Managed Postgres (free tier)

Your `.env.example` already anticipates this (`DATABASE_URL` comment mentions Neon/Supabase).

- [ ] **Neon** (recommended) — serverless Postgres, free tier ~0.5GB storage, autosuspends when idle (cold start on first query after idle).
- [ ] **Supabase** — free tier 500MB DB, pauses project after 1 week of inactivity (needs manual resume); brings extra features (auth/storage) you don't need here.
- [ ] Create the project/database in the chosen provider.
- [ ] Copy the **pooled** connection string (Neon: use the `-pooler` endpoint; needed because serverless/scale-to-zero platforms open many short-lived connections that will exhaust a direct Postgres connection limit).
- [ ] Update `DATABASE_URL` for prod: change `sslmode=prefer` → `sslmode=require` (or whatever the provider mandates).

### 2a. The application MUST connect as a non-superuser role (row-level security)

Multi-tenant isolation in this codebase is enforced by Postgres row-level security
policies (see `prisma/migrations/*_rls_policies`, `src/common/prisma/rls-context.ts`).
**A Postgres superuser, and any role holding `BYPASSRLS`, ignores those policies
entirely** — the tables are then readable and writable across every company, and no
error is raised to tell you so.

- [ ] Create a dedicated application role that is **`NOSUPERUSER`** and **`NOBYPASSRLS`**:

      CREATE ROLE buildcore_app LOGIN PASSWORD '<secret>'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      GRANT CONNECT ON DATABASE <db> TO buildcore_app;
      -- Repeat per schema (shared, settings, public):
      GRANT USAGE ON SCHEMA "<schema>" TO buildcore_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "<schema>" TO buildcore_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "<schema>" TO buildcore_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA "<schema>"
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO buildcore_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA "<schema>"
        GRANT USAGE, SELECT ON SEQUENCES TO buildcore_app;

- [ ] **Neon specifically**: the default `neondb_owner` role holds `BYPASSRLS`
      (`SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user` returns `t`).
      The application **refuses to boot in production** against it — deliberately, since
      every tenant-isolation policy would otherwise be silently ignored. The symptom is
      a deploy where migrations succeed and the process is then killed with `SIGTERM`
      without ever binding its port, because the preflight throws before `app.listen()`.
      Run `scripts/provision-app-role.sql` against the database and point the runtime
      `DATABASE_URL` at the role it creates:

      ```
      psql "<owner connection string>" \
        -v ON_ERROR_STOP=1 -v app_role=buildcore_app -v app_password='<secret>' \
        -f scripts/provision-app-role.sql
      ```

      It prints `rolsuper` and `rolbypassrls` at the end; both must be `f`. Keep the
      owner connection string for migrations — `start:migrate:prod` runs
      `prisma migrate deploy`, and the app role owns the tables so it can apply them.
- [ ] Re-run `scripts/provision-app-role.sql` whenever a migration adds a **new schema**.
      Its `owned_schemas` list is the single place that needs updating, and a schema
      missing from it leaves the role with no rights there at all — every query against
      it fails on permissions after an otherwise-successful deploy.
- [ ] Point the app's runtime `DATABASE_URL` at that role.
- [ ] Keep **migrations** running as the owning/admin role — `prisma migrate deploy` needs
      DDL rights the application role must not have.
- [ ] Verify after deploy:

      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;

      Both MUST be `false`. If either is `true`, tenant isolation is not in effect.

A local role matching this shape (`buildcore_app`) has been created for development, and
the e2e suite passes against it with the policies actually enforced.

**Neon-specific:** a role created with `CREATE ROLE ... PASSWORD ...` over SQL will show up
in `pg_roles` *and* in Neon's API, but **cannot authenticate** — Neon's connection proxy
checks its own stored credential, which it never learned for a SQL-created role, so you
get `password authentication failed`. After running the provisioning script, reset the
role's password through Neon so the control plane learns it:

```bash
curl -X POST -H "Authorization: Bearer $NEON_API_KEY" \
  "https://console.neon.tech/api/v2/projects/<project-id>/branches/<branch-id>/roles/buildcore_app/reset_password"
```

The response contains the password to put in `DATABASE_URL`. (Or use the Neon Console:
Roles → buildcore_app → Reset password.) Use the **direct**, non-`-pooler` host for
migrations.

**The application enforces this itself.** On startup it queries `rolsuper`/`rolbypassrls`
for its own connection (`src/common/prisma/rls-preflight.ts`) and, when `NODE_ENV` is
`production`, **refuses to boot** if either is true — a deploy that would silently run
without tenant isolation fails loudly instead of coming up healthy. Outside production it
logs a warning and continues, so a local superuser setup still works. If the check itself
cannot run (e.g. a missing catalog grant) it warns and continues rather than blocking a
deploy on an inconclusive result.

## 3. Object storage (Cloudflare R2) — implemented, credentials required

Implemented as of feature 003 (constitution v1.4.0). `StorageService` has two adapters chosen by
`STORAGE_DRIVER`: `local` (AES-256-GCM encrypted files, dev/test only) and `s3` (any S3-compatible
provider). Blobs are encrypted **in the application before upload**, so the provider only ever holds
ciphertext it has no key for — that is why provider-side encryption alone was not sufficient.

Consumers today: biometric enrolment photos and punch photos (003). Later: expense `receiptRef`
(003), `EmployeeDocument.fileRef` (005), contractor vault uploads (007), project attachments (008).

> **`STORAGE_DRIVER=local` in production silently destroys data.** Render's filesystem is ephemeral
> and free instances cannot attach a persistent disk, so every stored photo is lost on the next
> deploy or idle spin-down. **The app refuses to boot** in that configuration — it used to log a
> warning and start, which meant the misconfiguration stayed invisible until the data was already
> gone. A preview or staging host that serves no real users can set `ALLOW_LOCAL_STORAGE=true` to
> opt out; it then boots and warns loudly on every start. Never set it where real users exist.

### 3a. Create the R2 bucket

- [ ] Sign up at <https://dash.cloudflare.com/sign-up> (free; email verification required).
- [ ] R2 requires a payment method on file even though the free tier bills $0 — add a card under
      **Manage Account → Billing → Payment info**. If you would rather not, Backblaze B2 (10 GB) or
      Supabase Storage (1 GB, no card) work with the same adapter; only the endpoint changes.
- [ ] **R2 → Overview → Create bucket**. Name it (e.g. `buildcore-blobs`), pick a location hint near
      your users, and leave public access **off** — every read goes through the API, never the browser.
- [ ] **R2 → Manage API Tokens → Create API Token**, scoped **Object Read & Write** and restricted to
      that one bucket. Copy the **Access Key ID** and **Secret Access Key** — the secret is shown once.
- [ ] Note the **Account ID** from the R2 overview page; the endpoint is
      `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.

### 3b. Set the environment variables

- [ ] Generate the blob encryption key — **32 bytes, hex**:
      ```
      node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
      ```
      Store it somewhere durable before deploying. It is not recoverable, and losing it makes every
      stored photo permanently undecryptable — the blobs survive, the ability to read them does not.
- [ ] Set on the platform (never commit these):
      ```
      STORAGE_DRIVER=s3
      STORAGE_ENCRYPTION_KEY=<64 hex chars>
      STORAGE_S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
      STORAGE_S3_REGION=auto
      STORAGE_S3_BUCKET=buildcore-blobs
      STORAGE_S3_ACCESS_KEY_ID=<from the API token>
      STORAGE_S3_SECRET_ACCESS_KEY=<from the API token>
      STORAGE_S3_FORCE_PATH_STYLE=true
      ```
      `STORAGE_S3_FORCE_PATH_STYLE=true` is required by R2 and most S3-compatible providers; real
      AWS S3 wants `false`. `region=auto` is R2's convention.
- [ ] The S3 adapter validates all of these at construction, so a missing variable fails at startup
      rather than on a worker's first punch.

### 3c. Retention

- [ ] `WORKSPACE_PUNCH_PHOTO_RETENTION_DAYS` (default 15) exists and is read into config, but **no
      job consumes it yet** — see open task T094. Until that lands, punch photos accumulate
      indefinitely, which both grows toward the 10 GB free ceiling and leaves FR-026's
      retention-policy requirement unmet. Not a hard blocker for a pilot; is one before real scale.
- [ ] Virus scanning on uploads is explicitly deferred (`TODO(VIRUS_SCAN)`,
      `specs/005-hr-payroll-backend/research.md` §10) — a known gap, worth remembering before real
      user uploads.

## 4. Redis (BullMQ job queue) — not yet implemented, but required

`specs/004-dashboard-backend` requires Redis as `@nestjs/bullmq`'s backing store for async report
export (tasks.md T001-T002). Not yet in `docker-compose.yml` or `package.json`.

- [ ] Pick a free-tier Redis host:
  - **Upstash Redis** (recommended) — serverless, generous free tier, pay-per-request pricing beyond that, works well with scale-to-zero platforms like Cloud Run (no persistent connection issue since it's REST/TCP over a proxy).
  - **Redis Cloud** (Redis Labs) free tier — 30MB, fine for a job queue's small payloads, but a fixed always-on instance rather than serverless.
  - ~~Railway Redis~~ — same caveat as Railway hosting above, no real free tier anymore.
- [ ] Add a `docker-compose.redis.yml` (or extend `docker-compose.yml`) for local dev, matching the pattern `docker-compose.db.yml` already uses for Postgres.
- [ ] Add `REDIS_URL` (or host/port/password) to `.env.example` and platform secrets once T001/T002 land.
- [ ] Confirm the chosen Redis provider's TLS requirement — most free managed Redis requires `rediss://` (TLS) rather than plain `redis://`.

## 5. Secrets & config

- [ ] Generate real secrets — do **not** ship the `changeme-*` placeholders from `.env.example`:
  ```
  openssl rand -base64 48   # JWT_ACCESS_SECRET
  openssl rand -base64 48   # JWT_REFRESH_SECRET
  ```
- [ ] Set `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `PORT` in the platform's env var / secrets UI (never commit `.env`).
- [ ] Set `NODE_ENV=production`.
- [ ] **Restrict CORS.** Driven by `CORS_ORIGINS` (comma-separated) in `src/common/configs/config.ts`; unset means *allow any origin*, which is fine locally and wrong in production. Set it to the deployed frontend domain(s). Note this also flips the refresh cookie to `SameSite=none`, which is required for the split-origin (Vercel + Render) deployment.
- [ ] **Swagger is now gated** — `swagger.enabled` defaults to `NODE_ENV !== 'production'`, so `/api` and `/api-json` return 404 in production without any further action. Set `SWAGGER_ENABLED=true` only if you deliberately want docs on a staging deployment.
- [ ] Set `MAX_REQUEST_BODY_SIZE` if your devices produce unusually large captures; the 10 MB default covers a five-photo enrolment with headroom.

## 6. Docker / build

- [ ] `docker build .` locally to confirm the image builds clean (also try `Dockerfile.alpine` — smaller image, worth it if platform bills by image size/cold-start).
- [ ] Confirm `postinstall: prisma generate` runs during the platform's build (already in `package.json`, should just work).
- [ ] Wire `prisma migrate deploy` into the deploy flow — either as a Docker `CMD`/entrypoint step, a platform pre-deploy hook, or run manually against prod on first deploy and after each migration.

## 7. CI/CD

- [ ] Connect the GitHub repo to the platform for auto-deploy on push to `main`.
- [ ] Add a GitHub Actions workflow that runs `npm test` (and `npm run test:e2e` if it can run against a CI Postgres service) before deploy.
- [ ] Preview/staging environment: Render preview envs are a paid feature; Cloud Run revisions/tags give you this for free if you go that route.

## 8. Observability

- [ ] Add a health-check endpoint (`@nestjs/terminus`, or a plain `GET /health`) for the platform's health checks / uptime pings.
- [ ] Use the platform's built-in log viewer (both Render and Cloud Run include this free).
- [ ] Optional: Sentry free tier (5k events/month) for error tracking.

## 8a. Deploying the Settings module (feature 002) — one-time checks

Migrations run themselves: the Dockerfile's `CMD` is `start:migrate:prod`
(`prisma migrate deploy && node dist/main`), so a Render auto-deploy applies any pending
migration before the app starts. The three checks below are specific to this release and
only need doing once.

- [ ] **Confirm the database role does not bypass RLS — this can fail the deploy.**
      The app refuses to boot under `NODE_ENV=production` when its role is a superuser or
      holds `BYPASSRLS`, because every RLS policy is silently inert in that case (§2a).
      Run against production first:
      ```sql
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
      ```
      Both MUST be `false`. Supabase's default `postgres` role has `rolbypassrls = true`
      and **will** fail this; provision the role from §2a and repoint `DATABASE_URL`.

- [ ] **Never run `npm run seed` against production.** `prisma/seed.ts` deletes every
      `User`, `UserRole`, `RefreshToken` and `AuditLogEntry` before seeding — correct for a
      local fixture reset, catastrophic against real data. The nine default roles that
      production needs are seeded by migration `20260830090000_seed_default_roles` instead,
      which is idempotent and keyed on `Role.name`, so it refreshes permission sets without
      changing any role's `id` (existing `UserRole` assignments survive).

- [ ] **Expect existing accounts to lose their permissions.** Migration
      `20260828170000_role_permission_model` backfills only `ADMIN → Super Admin`; anyone
      who was `USER` ends up with no role and gets `403` on permission-gated endpoints until
      reassigned via Settings → Users. Before deploying, confirm at least one admin exists,
      or no one will be able to log in and fix it:
      ```sql
      SELECT email, role FROM shared."User" WHERE role = 'ADMIN';
      ```

- [ ] Confirm `CORS_ORIGINS` includes the deployed frontend origin (the Settings screens are
      entirely browser-driven; without this every call fails at the preflight).

- [ ] **Confirm auto-deploy actually fires.** The service is set to `autoDeploy: yes` with
      `autoDeployTrigger: commit`, but that only works if the **Render GitHub App is installed
      on the repository** — Render can clone a public repo without it, so builds and manual
      deploys succeed while pushes are silently ignored. After pushing to `main`, check Render
      → Events: a webhook-driven deploy shows a trigger of `deploy`/`new commit`, not `manual`,
      `api` or `CLI`. If every deploy in the history is manual, the App is missing: Settings →
      repository → Disconnect, then Connect via GitHub and grant access to this repo.

- [ ] `SETTINGS_DEFAULT_*` are optional — the statutory defaults (PF 12, ESIC 3.25, Gratuity
      4.81, Bonus 8.33, lock day 7) apply when unset. Set them only to override.

## 9. Post-deploy verification

- [ ] Hit the deployed health endpoint and `/api` (Swagger) if enabled.
- [ ] Run the full login/refresh-token flow against the production DB.
- [ ] Confirm CORS actually works from the deployed frontend origin (not just `localhost`).
- [ ] Point a custom domain (e.g. `api.yourdomain.com`) at the service; confirm auto-provisioned SSL.

## 10. Free-tier limits to watch

- [ ] Render free web service: ~750 instance-hours/month shared across free services, sleeps after 15 min idle.
- [ ] Neon free tier: storage cap + autosuspend — check usage periodically as data grows.
- [ ] R2/B2 free storage tier: watch GB-stored as document/photo uploads accumulate (these don't autosuspend or expire, so this one only grows).
- [ ] Upstash/Redis Cloud free tier: request count / memory cap for BullMQ once report exports are live.
- [ ] Set a reminder to revisit before any of these limits becomes a problem.
