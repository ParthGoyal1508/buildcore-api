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

## 3. Object storage (files/documents) — not yet implemented, but required

Multiple specs require "encrypted object-storage references" for uploaded files, though **no
vendor has been chosen yet** — this is an open infra decision, not just a deployment step:

- `specs/003-my-workspace-backend`: biometric enrolment photos, expense `receiptRef`
- `specs/005-hr-payroll-backend`: `EmployeeDocument.fileRef`
- `specs/007-partners-backend`: contractor vault document uploads (FR-011)
- `specs/008-projects-backend`: per-project file attachments

- [ ] Pick a provider (free-tier options, all S3-API-compatible so the code stays portable):
  - **Cloudflare R2** — 10GB storage free, **zero egress fees** (the others charge for egress) — best fit if downloads matter.
  - **Supabase Storage** — 1GB free; only worth it if you also pick Supabase for Postgres (§2), otherwise skip.
  - **Backblaze B2** — 10GB free, small egress allowance.
  - ~~AWS S3~~ — free tier is 12 months only, then billed; skip unless you're already in the AWS ecosystem.
- [ ] Decide where encryption happens: server-side encryption at the bucket (provider-managed) vs. app-level encryption before upload — the specs say "encrypted," check which tier they mean before building the upload handler.
- [ ] Add bucket credentials (access key/secret, bucket name, endpoint) as platform secrets alongside `DATABASE_URL`/JWT secrets.
- [ ] Note: `specs/005-hr-payroll-backend/research.md` §10 explicitly defers virus scanning on uploads (`TODO(VIRUS_SCAN)`) — tracked as a known gap, not blocking deployment, but worth remembering before this goes live with real user uploads.

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
- [ ] **Restrict CORS.** `src/main.ts` currently calls `app.enableCors()` with no options — this allows *any* origin. Before going live, lock it to the deployed frontend domain(s), e.g.:
  ```ts
  app.enableCors({ origin: [process.env.FRONTEND_URL, 'https://*.vercel.app'] });
  ```
  (Coordinate the exact origin(s) with the frontend checklist.)
- [ ] Decide whether Swagger (`/api` docs) should stay open in prod — currently `swagger.enabled: true` unconditionally in `src/common/configs/config.ts`. If it should be gated, wire it off an env var.

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
