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

-- 3. Hand over the three schemas this application owns, and everything in them.
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
BEGIN
  -- Schema ownership is taken only for the two schemas this application created.
  -- `public` is deliberately left alone: some hosts (Supabase in particular) keep
  -- their own managed objects there, and reassigning it can break their tooling.
  -- The app only needs USAGE + CREATE on it, plus ownership of _prisma_migrations
  -- (handled by the table loop below).
  FOREACH sn IN ARRAY ARRAY['shared','settings'] LOOP
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = sn) THEN
      EXECUTE format('ALTER SCHEMA %I OWNER TO %I', sn, role_name);
    END IF;
  END LOOP;

  FOREACH sn IN ARRAY ARRAY['public','shared','settings'] LOOP
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = sn) THEN
      EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO %I', sn, role_name);
    END IF;
  END LOOP;

  FOR r IN SELECT schemaname, tablename FROM pg_tables
           WHERE schemaname IN ('public','shared','settings') LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO %I', r.schemaname, r.tablename, role_name);
  END LOOP;

  FOR r IN SELECT n.nspname AS schemaname, t.typname AS tablename
           FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname IN ('public','shared','settings') AND t.typtype = 'e' LOOP
    EXECUTE format('ALTER TYPE %I.%I OWNER TO %I', r.schemaname, r.tablename, role_name);
  END LOOP;

  FOR r IN SELECT sequence_schema AS schemaname, sequence_name AS tablename
           FROM information_schema.sequences
           WHERE sequence_schema IN ('public','shared','settings') LOOP
    EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO %I', r.schemaname, r.tablename, role_name);
  END LOOP;
END $do$;

COMMIT;

-- 4. Verify. BOTH columns MUST be false, or the application will refuse to boot.
SELECT rolname, rolsuper, rolbypassrls
FROM pg_roles WHERE rolname = :'app_role';
