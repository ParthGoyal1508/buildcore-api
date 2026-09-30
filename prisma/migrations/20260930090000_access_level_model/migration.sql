-- 019 Phase 1, 2026-09-30. The read/write level, inert.
--
-- Permissions today are module-shaped and level-less: holding `MACHINERY` means reading
-- and writing everything in it, and there is no way to express the client's Note 22 —
-- a site operator who may enter logbook readings and diesel but may not *edit* anything
-- else. `LOGBOOK` and `FUEL` are already distinct permission values, so the area half of
-- that example already works; what is missing is the level, and this migration adds it.
--
-- NOTHING READS `RolePermission` AFTER THIS MIGRATION. That is the design: Phase 2
-- switches the guard over, and until it does, `Role.permissions` remains the source of
-- truth. Two consequences worth stating, because both are load-bearing:
--
--   1. This migration cannot change anybody's access, so the before/after access matrix
--      (`scripts/access-matrix.ts`, FR-006, SC-002) must be byte-identical. That
--      comparison is the gate on Phase 2, not a successful deploy.
--   2. `Role.permissions` is NOT dropped here. It is the rollback: reverting Phase 2 is
--      then a code revert with no data loss. A later migration drops it once a release
--      has proved the new path.

-- ── RLS context for the data statements below ────────────────────────────────
--
-- The backfill writes one row per role per permission per level — a write over every
-- role in the system. Production connects as `buildcore_app` (NOSUPERUSER,
-- NOBYPASSRLS); local development connects as a SUPERUSER and bypasses RLS entirely,
-- which is why this class of defect cannot be caught by running migrations locally.
--
-- `RolePermission` itself is not RLS'd (see below), but this statement is written with
-- the guard anyway, because it is cheap and because the failure it prevents here would
-- be the worst instance of it in this repository's history: an INSERT ... SELECT that
-- matched zero rows would leave the deploy green with **every role holding nothing**,
-- and the symptom would be every user in the system losing every permission at once.
-- Five migrations failed this way in production on 2026-09-16.
--
-- Transaction-local (third argument), so it cannot leak into a later session.
SELECT set_config('app.is_super_admin', 'true', true);

CREATE TYPE "settings"."AccessLevel" AS ENUM ('read', 'write');

CREATE TABLE "settings"."RolePermission" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permission" "settings"."Permission" NOT NULL,
    "level" "settings"."AccessLevel" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

-- A grant is present or absent, never duplicated.
CREATE UNIQUE INDEX "RolePermission_roleId_permission_level_key"
  ON "settings"."RolePermission"("roleId", "permission", "level");

CREATE INDEX "RolePermission_roleId_idx" ON "settings"."RolePermission"("roleId");

ALTER TABLE "settings"."RolePermission"
  ADD CONSTRAINT "RolePermission_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "settings"."Role"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Deliberately NO row-level security on this table ─────────────────────────
--
-- `settings.Role` carries no `companyId` and no RLS, and that is not an oversight —
-- migration `20260828170000_role_permission_model` states the reasoning at its line 84:
-- who *holds* a role is tenant data, so `UserRole` is RLS'd, while a role's own
-- definition is not. `RolePermission` is a child of that global table, so there is no
-- tenant key to write a policy against.
--
-- Written out rather than left silent, because the alternative considered was a policy
-- keyed on the role's holders through `UserRole`. That was rejected: it would read as
-- isolation to the next person while enforcing nothing useful (a role held in two
-- companies would be visible to both regardless), and a policy that looks like a
-- boundary and is not is worse than an honest absence.

-- ── The backfill ────────────────────────────────────────────────────────────
--
-- Every entry in every role's array becomes TWO rows, `read` and `write`.
--
-- That is FR-006 read literally rather than interpreted. Holding `MACHINERY` has always
-- meant reading and writing it, so both rows are exactly today's access — no role
-- becomes tighter until somebody deliberately tightens it, and the access matrix
-- therefore cannot change. The safe default is the one that preserves behaviour, not the
-- one that sounds more secure: a migration that silently made every role read-only would
-- lock every user out of every write in the system.
--
-- `unnest` over the array, cross-joined with the two levels. `gen_random_uuid()` for the
-- id: cuid is generated in application code and this statement has none available, and
-- the column is an opaque key nothing joins on by shape.
INSERT INTO "settings"."RolePermission" ("id", "roleId", "permission", "level", "createdAt")
SELECT
  gen_random_uuid()::text,
  r."id",
  p."permission",
  l."level",
  CURRENT_TIMESTAMP
FROM "settings"."Role" r
CROSS JOIN LATERAL unnest(r."permissions") AS p("permission")
CROSS JOIN (VALUES ('read'::"settings"."AccessLevel"), ('write'::"settings"."AccessLevel")) AS l("level")
ON CONFLICT ("roleId", "permission", "level") DO NOTHING;

-- 019 FR-014. A display control (FR-017 keeps the data untouched), defaulting to off:
-- one arriving switched on would hide figures nobody asked to hide.
ALTER TABLE "settings"."Company"
  ADD COLUMN "hideCashTransactions" BOOLEAN NOT NULL DEFAULT false;
