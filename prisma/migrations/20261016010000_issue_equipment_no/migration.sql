-- The issue slip's "Equipment No." is kept as the machine's number in text (2026-10-15): inventory
-- does not read plant's tables, and the slip prints the number.
ALTER TABLE "inventory"."Issue" RENAME COLUMN "equipmentId" TO "equipmentNo";
