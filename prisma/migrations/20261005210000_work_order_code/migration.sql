-- Work order numbering and attribution (027).
--
-- A work order had no identifier of its own — only its free-text detail — so the one screen that
-- must name one, composing a bill to a subcontractor, had nothing to offer but a cuid. It gets a
-- number on the same per-company series every other code in this product uses.
--
-- `code` is nullable because the table is populated: a required unique column cannot be added to
-- rows that have no value for it, and inventing numbers for existing work orders would put a
-- figure on a document that nobody issued. Those rows keep reading by their detail; everything
-- raised from here on is numbered.

-- AlterEnum
ALTER TYPE "settings"."CodeSeriesType" ADD VALUE 'WORK_ORDER';

-- AlterTable
ALTER TABLE "projects"."WorkOrder" ADD COLUMN     "code" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrder_companyId_code_key" ON "projects"."WorkOrder"("companyId", "code");
