-- 2026-10-12. Row-level security for `settings.LetterKindField`, the one table in the
-- letters feature that shipped without a policy.
--
-- Hand-written, not generated: a policy is not expressible in a Prisma schema, so
-- `prisma migrate diff` cannot produce one. Same category as every other RLS migration
-- here (see `20260930180000_exit_clearance_waiver`). No data statement, so no
-- `set_config` guard — that line belongs where a backfill exists and nowhere else.
--
-- **Scoped through the parent kind, because this table has no `companyId`.** A field
-- belongs to a `LetterKind`, and that is where the tenancy lives. The predicate below
-- restates `LetterKind`'s own policy rather than leaning on it being applied inside a
-- sub-select: explicit is cheap here, and the alternative is a policy whose correctness
-- depends on a subtlety of how Postgres evaluates nested table access.
--
-- A product-shipped kind (`companyId IS NULL`) is visible to every company, so its
-- fields are too — that vocabulary *is* the product's, and every company composes
-- templates against it.
--
-- `WITH CHECK` deliberately mirrors `USING` rather than also refusing a shipped-kind
-- parent. Two reasons. Tenancy is what RLS is for, and "a shipped kind may not be
-- edited" is a product rule, enforced in `LetterKindFieldsService` where it can answer
-- 409 with a code and a sentence. And `StandardTemplatesService.install` writes the
-- shipped kinds' own fields under the *caller's* company context, so a stricter check
-- here would stop a new company getting its standard templates at all.

ALTER TABLE "settings"."LetterKindField" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"."LetterKindField" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "settings"."LetterKindField"
  USING (
    EXISTS (
      SELECT 1
      FROM "settings"."LetterKind" k
      WHERE k."id" = "letterKindId"
        AND (
          k."companyId" IS NULL
          OR current_setting('app.is_super_admin', true) = 'true'
          OR k."companyId" = current_setting('app.current_company_id', true)
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM "settings"."LetterKind" k
      WHERE k."id" = "letterKindId"
        AND (
          k."companyId" IS NULL
          OR current_setting('app.is_super_admin', true) = 'true'
          OR k."companyId" = current_setting('app.current_company_id', true)
        )
    )
  );
