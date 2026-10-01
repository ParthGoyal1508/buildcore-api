-- 020 FR-013: the hard punch refusal, behind a per-company switch.
--
-- Additive and default-false, so applying this migration changes no behaviour anywhere. That is
-- deliberate: the refusal log is still measuring how often the block would fire, and the client's
-- decision stays reversible until somebody sets this to true for a named company.
ALTER TABLE "settings"."Company"
  ADD COLUMN "punchBlockEnforced" BOOLEAN NOT NULL DEFAULT false;
