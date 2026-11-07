-- The Cashier's permission (client, 2026-11-07): record payments — and client receipts — on each
-- module's payment screen, read-only otherwise. Alone in its migration: a value added to an enum
-- cannot be used in the same transaction.
ALTER TYPE "settings"."Permission" ADD VALUE IF NOT EXISTS 'PAYMENTS';
