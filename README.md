# BuildCore API

REST API for BuildCore ERP — NestJS 10 + Prisma 5 + PostgreSQL, JWT auth (access + refresh tokens), Swagger docs.

Scaffolded from [notiz-dev/nestjs-prisma-starter](https://github.com/notiz-dev/nestjs-prisma-starter) with the GraphQL layer removed and rebuilt as REST controllers, per `docs/HLD.md` (§6 API Design) and `docs/prd/00-master-prd.md` in the [ERP-Demo](../ERP-Demo) repo. See that HLD for the full module-to-service mapping, the schema-per-module database pattern (§5.1), and the package list this scaffold is meant to grow into.

## What's here

- `auth` — signup, login, refresh-token rotation (JWT access + refresh), Passport JWT strategy
- `users` — `/users/me` (get/update), password change
- Prisma (`prisma/schema.prisma`) with a single placeholder `User` model — the real per-module schema (`hr`, `payroll`, `projects`, `plant`, `inventory`, `partners`, `settings`, `shared`) is the next task, not yet written
- Swagger UI at `/api` once running
- Password hashing via `argon2` (not `bcrypt` — the original starter used bcrypt; swapped per the HLD's package recommendation)

## What's deliberately not here yet

Scope was "get a working REST + Prisma + JWT skeleton running," not the full HLD package list. Still to wire, in roughly this order:

1. **Field-level Prisma schema per ERP module** — the actual employees/attendance/payroll/etc. tables (HLD §5.1)
2. RBAC guards/roles (currently just authenticated vs. not)
3. `@nestjs/event-emitter` for cross-module domain events (HLD §5.1)
4. `@nestjs/bullmq` for background jobs (payroll runs, PDF generation, reports)
5. `@nestjs/throttler` (rate limiting), `nestjs-pino` (structured logging), `@nestjs/terminus` (`/health`, `/readyz`), `helmet` — all in HLD §9.3
6. `@nestjs/config` + Zod schema validation for environment variables (currently unvalidated)

## Getting started

```bash
npm install
cp .env.example .env        # then edit JWT secrets + DB credentials
npm run docker:db           # starts local Postgres via Docker
npm run migrate:dev         # creates the database schema
npm run seed                # seeds admin@buildcore.dev / user@buildcore.dev (password: secret42)
npm run start:dev
```

API root: `http://localhost:3000` · Swagger UI: `http://localhost:3000/api`

## Scripts

| Command | Does |
|---|---|
| `npm run start:dev` | Dev server, watch mode |
| `npm run build` | Production build |
| `npm run migrate:dev` | Create + apply a Prisma migration |
| `npm run migrate:deploy` | Apply pending migrations (CI/CD) |
| `npm run prisma:studio` | Prisma's DB browser GUI |
| `npm test` / `npm run test:e2e` | Unit / e2e tests (e2e needs a running Postgres) |
| `npm run docker` | Build + run API and Postgres in Docker |
