-- What was typed when a letter was composed, kept so a letter issued after its approval still
-- carries it. See `IssuedLetter.composedVariables`.
ALTER TABLE "shared"."IssuedLetter" ADD COLUMN "composedVariables" JSONB;
