-- Provisions a database role the application can safely connect as.
--
-- Run this ONCE against the production database, connected as your current admin
-- role (the one that holds BYPASSRLS). Replace the password before running.
--
-- Why this is needed: Postgres exempts superusers and BYPASSRLS roles from row-level
-- security unconditionally, so connecting as one silently disables every tenant
-- isolation policy in this schema. The application refuses to boot in production in
-- that state (src/common/prisma/rls-preflight.ts), which is what this fixes.
--
-- Ownership is transferred, not just privileges granted: `prisma migrate deploy`
-- runs as this same role on every start, and CREATE POLICY / ALTER TABLE require
-- ownership of the table being altered.

-- Both values are psql variables so this can be run as-is:
--   psql "<admin-connection-string>" \
--     -v app_role=buildcore_app -v app_password="'a-strong-password'" \
--     -f scripts/provision-app-role.sql
\if :{?app_role}
\else
  \set app_role buildcore_app
\endif

BEGIN;

-- 1. The application role: no superuser, and critically no BYPASSRLS, so the
--    policies actually apply to it.
CREATE ROLE :"app_role" LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

-- Required before ALTER ... OWNER TO: the current role must be a member of the
-- role it is handing ownership to.
GRANT :"app_role" TO CURRENT_USER;

-- 2. Connect + create rights (future migrations may add a schema).
-- :"DBNAME" is psql's built-in variable for the database you are connected to.
GRANT CONNECT ON DATABASE :"DBNAME" TO :"app_role";
GRANT CREATE  ON DATABASE :"DBNAME" TO :"app_role";

-- 3. Hand over the schemas this application owns, and everything in them.
--    Scoped deliberately to these schemas — a blanket REASSIGN OWNED would also
--    move provider-managed objects in other schemas, which on some hosts breaks
--    the platform's own tooling.
-- psql does not substitute :variables inside a dollar-quoted block, so the role
-- name is handed to it through a session setting instead.
SELECT set_config('buildcore.app_role', :'app_role', false);

DO $do$
DECLARE
  r    record;
  sn   text;
  role_name text := current_setting('buildcore.app_role');

  -- The schemas this application creates and owns. Declared ONCE and reused by
  -- every loop below: this list was previously repeated four times, and when
  -- feature 003 added `hr`, `projects` and `payroll` the copies fell out of step —
  -- the role was provisioned with no rights on the new schemas at all, so every
  -- query against them failed on permissions after a clean deploy.
  --
  -- Add a schema here when a migration introduces one, and re-run this script.
  owned_schemas text[] := ARRAY['shared','settings','hr','projects','payroll'];

  -- `public` is granted and its tables are re-owned (for `_prisma_migrations`), but
  -- the schema itself is deliberately NOT reassigned: some hosts keep their own
  -- managed objects there and taking ownership breaks their tooling.
  all_schemas text[] := ARRAY['public'] || owned_schemas;
BEGIN
  -- Ownership of the application's own schemas.
  --
  -- Owning the tables does not defeat row-level security here: a table owner would
  -- normally bypass its own policies, which is precisely why every policy in this
  -- codebase is created with FORCE ROW LEVEL SECURITY (see the *_rls_policies
  -- migrations). Ownership is still required so `prisma migrate deploy` can alter
  -- these tables on a future release.
  FOREACH sn IN ARRAY owned_schemas LOOP
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = sn) THEN
      EXECUTE format('ALTER SCHEMA %I OWNER TO %I', sn, role_name);
    END IF;
  END LOOP;

  FOREACH sn IN ARRAY all_schemas LOOP
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = sn) THEN
      EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO %I', sn, role_name);
    END IF;
  END LOOP;

  FOR r IN SELECT schemaname, tablename FROM pg_tables
           WHERE schemaname = ANY(all_schemas) LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO %I', r.schemaname, r.tablename, role_name);
  END LOOP;

  FOR r IN SELECT n.nspname AS schemaname, t.typname AS tablename
           FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = ANY(all_schemas) AND t.typtype = 'e' LOOP
    EXECUTE format('ALTER TYPE %I.%I OWNER TO %I', r.schemaname, r.tablename, role_name);
  END LOOP;

  FOR r IN SELECT sequence_schema AS schemaname, sequence_name AS tablename
           FROM information_schema.sequences
           WHERE sequence_schema = ANY(all_schemas) LOOP
    EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO %I', r.schemaname, r.tablename, role_name);
  END LOOP;
END $do$;

COMMIT;

-- 4. Verify. BOTH columns MUST be false, or the application will refuse to boot.
SELECT rolname, rolsuper, rolbypassrls
FROM pg_roles WHERE rolname = :'app_role';
