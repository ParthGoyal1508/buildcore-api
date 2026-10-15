-- The offer, appointment, experience and relieving letters carry the company's signature
-- (2026-10-15).
--
-- Each of the client's formats closes "For <company>", space to sign, "Authorized Signatory" (the
-- offer letter: the signatory's designation). They were shipped unsigned in 20260915170500, when
-- no signature was applied to any letter, and so issued with no signing block at all. Signed, the
-- composer asks for a signatory (defaulting to the company's first) and the issued letter carries
-- their graphic, as the increment, transfer and termination letters already do.
--
-- Data only, and only the product-shipped rows (`companyId` NULL); idempotent.

UPDATE "settings"."LetterKind"
SET "requiresSignature" = true,
    "updatedAt" = NOW()
WHERE "companyId" IS NULL
  AND "key" IN ('offer', 'appointment', 'experience', 'relieving')
  AND "requiresSignature" = false;
