-- Row-level security for shared.InviteToken, reusing the session-variable pattern
-- set by src/common/prisma/rls-context.ts (Principle IV). Policy-only migration:
-- Prisma models RLS nowhere in schema.prisma, so this is hand-authored SQL, the same
-- exception features 001, 002 and 003 already take.
--
-- Scoped through the owning User rather than by a denormalized "companyId" column of
-- its own, which is how the neighbouring shared."RefreshToken" does it. The reason
-- for diverging: an invite is a 48-hour object whose tenancy is entirely derived
-- from the account it belongs to, and copying the company id would make it possible
-- for the two to disagree — an account moved between companies would leave invites
-- claiming the old one. shared."User" is itself RLS-protected, so this check cannot
-- be satisfied via a user the caller may not see, and the userId index below keeps
-- it a lookup rather than a scan.
--
-- The public validate/set-password endpoints look a token up by hash with no
-- authenticated caller, exactly as login looks an account up by email; those run
-- under the system context and bypass this policy by design. It exists to stop one
-- company's administrators from enumerating another's pending invites.

ALTER TABLE "shared"."InviteToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."InviteToken" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "shared"."InviteToken"
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "shared"."User" u
      WHERE u."id" = "shared"."InviteToken"."userId"
        AND u."companyId" = current_setting('app.current_company_id', true)
    )
  );
