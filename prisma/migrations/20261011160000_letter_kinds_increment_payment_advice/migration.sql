-- Two letter kinds the client's documents need and this product did not ship
-- (2026-10-11): the increment letter and the vendor payment advice.
--
-- Hand-written, like `20261007090000`, because this is data rather than structure.
-- `prisma migrate diff` cannot see it and must not be asked to: these are rows in
-- `LetterKind`, not columns.
--
-- `companyId` NULL means a kind this product ships for everyone, the same nullable-tenant
-- pattern `ReminderRule` uses. The conflict target is the hand-authored partial unique
-- index `LetterKind_shipped_key`, because Postgres treats NULLs as distinct and the plain
-- composite would happily admit a second `(NULL, 'increment')` row — the note on the model
-- says so, and `20260915170500` took the same precaution for the original fifteen.
--
-- Ids follow the `ltrkind_*` convention of that migration rather than being generated, so
-- a later data migration can reference them by name.
--
-- Neither requires approval: an increment letter follows a pay decision already made, and
-- a payment advice follows a transfer already initiated. Gating the paperwork after the
-- fact would stop the document, not the money. `requiresSignature` is false on the advice
-- because the client's own form says it is computer-generated and needs no signature.
INSERT INTO "settings"."LetterKind"
  ("id", "companyId", "key", "label", "requiresSignature", "requiresApproval", "approvalActionType", "isActive", "createdAt", "updatedAt")
VALUES
  ('ltrkind_increment',      NULL, 'increment',      'Increment letter', true,  false, NULL, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ltrkind_payment_advice', NULL, 'payment_advice', 'Payment advice',   false, false, NULL, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") WHERE "companyId" IS NULL DO NOTHING;
