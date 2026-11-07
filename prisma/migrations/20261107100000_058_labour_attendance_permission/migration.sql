-- 058 US4: the site supervisor's narrow labour permission. Alone in its migration: a value added to
-- an enum cannot be used in the same transaction, and the next migration moves a role onto it.
ALTER TYPE "settings"."Permission" ADD VALUE IF NOT EXISTS 'LABOUR_ATTENDANCE';
