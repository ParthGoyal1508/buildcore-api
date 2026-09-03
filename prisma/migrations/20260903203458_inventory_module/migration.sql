-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "inventory";

-- CreateEnum
CREATE TYPE "settings"."ItemUnit" AS ENUM ('BAG', 'CUM', 'KG', 'NOS', 'MT', 'LTR', 'RMT', 'SQM');

-- CreateEnum
CREATE TYPE "inventory"."StockLedgerType" AS ENUM ('purchase', 'purchase_reversal', 'issue', 'issue_reversal', 'transfer_in', 'transfer_out', 'transfer_in_reversal', 'transfer_out_reversal');

-- CreateEnum
CREATE TYPE "inventory"."PurchaseBillStatus" AS ENUM ('unpaid', 'part_paid', 'paid');

-- CreateEnum
CREATE TYPE "inventory"."PaymentMode" AS ENUM ('upi', 'bank_transfer', 'cash', 'cheque');

-- CreateEnum
CREATE TYPE "inventory"."TransferStatus" AS ENUM ('pending', 'in_transit', 'received');

-- CreateEnum
CREATE TYPE "inventory"."IndentStatus" AS ENUM ('draft', 'submitted', 'approved', 'rejected', 'partially_fulfilled', 'fulfilled', 'cancelled');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "settings"."CodeSeriesType" ADD VALUE 'ITEMS';
ALTER TYPE "settings"."CodeSeriesType" ADD VALUE 'INDENT';

-- AlterEnum
ALTER TYPE "settings"."Permission" ADD VALUE 'INVENTORY_APPROVE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'ITEM_CATEGORY';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'ITEM';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'PURCHASE';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'GOODS_RECEIPT_NOTE';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'ISSUE';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'STOCK_TRANSFER';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'PAYMENT';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'MATERIAL_INDENT';

-- CreateTable
CREATE TABLE "settings"."ItemCategory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ItemCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings"."Item" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "unit" "settings"."ItemUnit" NOT NULL,
    "reorderLevel" DECIMAL(18,3),
    "hsnCode" TEXT,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."StockBalance" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "received" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "issued" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "transferIn" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "transferOut" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "avgRate" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."StockLedgerEntry" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "type" "inventory"."StockLedgerType" NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "rate" DECIMAL(18,2),
    "referenceId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."Purchase" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "rate" DECIMAL(18,2) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "billFileRef" TEXT,
    "remarks" TEXT,
    "indentLineId" TEXT,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."GoodsReceiptNote" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "grnNumber" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoodsReceiptNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."PurchaseBill" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "totalAmount" DECIMAL(18,2) NOT NULL,
    "paidAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "paymentStatus" "inventory"."PurchaseBillStatus" NOT NULL DEFAULT 'unpaid',
    "billDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseBill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."Issue" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "issuedTo" TEXT NOT NULL,
    "activityId" TEXT,
    "boqItemId" TEXT,
    "remarks" TEXT,
    "indentLineId" TEXT,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Issue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."StockTransfer" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "fromSiteId" TEXT NOT NULL,
    "toSiteId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "remarks" TEXT,
    "status" "inventory"."TransferStatus" NOT NULL DEFAULT 'pending',
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."Payment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "date" DATE NOT NULL,
    "paymentMode" "inventory"."PaymentMode" NOT NULL,
    "referenceNumber" TEXT NOT NULL,
    "allocatedAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."PaymentAllocation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "allocatedAmount" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."MaterialIndent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "projectId" TEXT,
    "indentNumber" TEXT NOT NULL,
    "requiredByDate" DATE NOT NULL,
    "justification" TEXT NOT NULL,
    "status" "inventory"."IndentStatus" NOT NULL DEFAULT 'submitted',
    "requestedByUserId" TEXT NOT NULL,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaterialIndent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."MaterialIndentLine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "indentId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "requestedQuantity" DECIMAL(18,3) NOT NULL,
    "approvedQuantity" DECIMAL(18,3),
    "fulfilledQuantity" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "reductionReason" TEXT,
    "activityId" TEXT,
    "boqItemId" TEXT,
    "procurementPending" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaterialIndentLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ItemCategory_companyId_idx" ON "settings"."ItemCategory"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemCategory_companyId_name_key" ON "settings"."ItemCategory"("companyId", "name");

-- CreateIndex
CREATE INDEX "Item_companyId_idx" ON "settings"."Item"("companyId");

-- CreateIndex
CREATE INDEX "Item_companyId_categoryId_idx" ON "settings"."Item"("companyId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Item_companyId_name_key" ON "settings"."Item"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Item_companyId_code_key" ON "settings"."Item"("companyId", "code");

-- CreateIndex
CREATE INDEX "StockBalance_companyId_idx" ON "inventory"."StockBalance"("companyId");

-- CreateIndex
CREATE INDEX "StockBalance_companyId_siteId_idx" ON "inventory"."StockBalance"("companyId", "siteId");

-- CreateIndex
CREATE UNIQUE INDEX "StockBalance_itemId_siteId_key" ON "inventory"."StockBalance"("itemId", "siteId");

-- CreateIndex
CREATE INDEX "StockLedgerEntry_companyId_itemId_siteId_idx" ON "inventory"."StockLedgerEntry"("companyId", "itemId", "siteId");

-- CreateIndex
CREATE INDEX "StockLedgerEntry_referenceId_idx" ON "inventory"."StockLedgerEntry"("referenceId");

-- CreateIndex
CREATE INDEX "Purchase_companyId_idx" ON "inventory"."Purchase"("companyId");

-- CreateIndex
CREATE INDEX "Purchase_companyId_siteId_idx" ON "inventory"."Purchase"("companyId", "siteId");

-- CreateIndex
CREATE INDEX "Purchase_companyId_vendorId_idx" ON "inventory"."Purchase"("companyId", "vendorId");

-- CreateIndex
CREATE INDEX "Purchase_companyId_itemId_siteId_idx" ON "inventory"."Purchase"("companyId", "itemId", "siteId");

-- CreateIndex
CREATE INDEX "Purchase_indentLineId_idx" ON "inventory"."Purchase"("indentLineId");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceiptNote_purchaseId_key" ON "inventory"."GoodsReceiptNote"("purchaseId");

-- CreateIndex
CREATE INDEX "GoodsReceiptNote_companyId_idx" ON "inventory"."GoodsReceiptNote"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceiptNote_companyId_grnNumber_key" ON "inventory"."GoodsReceiptNote"("companyId", "grnNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseBill_purchaseId_key" ON "inventory"."PurchaseBill"("purchaseId");

-- CreateIndex
CREATE INDEX "PurchaseBill_companyId_idx" ON "inventory"."PurchaseBill"("companyId");

-- CreateIndex
CREATE INDEX "PurchaseBill_companyId_vendorId_paymentStatus_billDate_idx" ON "inventory"."PurchaseBill"("companyId", "vendorId", "paymentStatus", "billDate");

-- CreateIndex
CREATE INDEX "Issue_companyId_idx" ON "inventory"."Issue"("companyId");

-- CreateIndex
CREATE INDEX "Issue_companyId_siteId_idx" ON "inventory"."Issue"("companyId", "siteId");

-- CreateIndex
CREATE INDEX "Issue_companyId_itemId_siteId_idx" ON "inventory"."Issue"("companyId", "itemId", "siteId");

-- CreateIndex
CREATE INDEX "Issue_indentLineId_idx" ON "inventory"."Issue"("indentLineId");

-- CreateIndex
CREATE INDEX "StockTransfer_companyId_idx" ON "inventory"."StockTransfer"("companyId");

-- CreateIndex
CREATE INDEX "StockTransfer_companyId_fromSiteId_idx" ON "inventory"."StockTransfer"("companyId", "fromSiteId");

-- CreateIndex
CREATE INDEX "StockTransfer_companyId_toSiteId_idx" ON "inventory"."StockTransfer"("companyId", "toSiteId");

-- CreateIndex
CREATE INDEX "Payment_companyId_idx" ON "inventory"."Payment"("companyId");

-- CreateIndex
CREATE INDEX "Payment_companyId_vendorId_idx" ON "inventory"."Payment"("companyId", "vendorId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_companyId_idx" ON "inventory"."PaymentAllocation"("companyId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_billId_idx" ON "inventory"."PaymentAllocation"("billId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAllocation_paymentId_billId_key" ON "inventory"."PaymentAllocation"("paymentId", "billId");

-- CreateIndex
CREATE INDEX "MaterialIndent_companyId_idx" ON "inventory"."MaterialIndent"("companyId");

-- CreateIndex
CREATE INDEX "MaterialIndent_companyId_status_idx" ON "inventory"."MaterialIndent"("companyId", "status");

-- CreateIndex
CREATE INDEX "MaterialIndent_companyId_siteId_idx" ON "inventory"."MaterialIndent"("companyId", "siteId");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialIndent_companyId_indentNumber_key" ON "inventory"."MaterialIndent"("companyId", "indentNumber");

-- CreateIndex
CREATE INDEX "MaterialIndentLine_companyId_idx" ON "inventory"."MaterialIndentLine"("companyId");

-- CreateIndex
CREATE INDEX "MaterialIndentLine_indentId_idx" ON "inventory"."MaterialIndentLine"("indentId");

-- CreateIndex
CREATE INDEX "MaterialIndentLine_companyId_itemId_idx" ON "inventory"."MaterialIndentLine"("companyId", "itemId");

-- AddForeignKey
ALTER TABLE "settings"."ItemCategory" ADD CONSTRAINT "ItemCategory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings"."Item" ADD CONSTRAINT "Item_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings"."Item" ADD CONSTRAINT "Item_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "settings"."ItemCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."Purchase" ADD CONSTRAINT "Purchase_indentLineId_fkey" FOREIGN KEY ("indentLineId") REFERENCES "inventory"."MaterialIndentLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."GoodsReceiptNote" ADD CONSTRAINT "GoodsReceiptNote_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "inventory"."Purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."PurchaseBill" ADD CONSTRAINT "PurchaseBill_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "inventory"."Purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."Issue" ADD CONSTRAINT "Issue_indentLineId_fkey" FOREIGN KEY ("indentLineId") REFERENCES "inventory"."MaterialIndentLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "inventory"."Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_billId_fkey" FOREIGN KEY ("billId") REFERENCES "inventory"."PurchaseBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."MaterialIndentLine" ADD CONSTRAINT "MaterialIndentLine_indentId_fkey" FOREIGN KEY ("indentId") REFERENCES "inventory"."MaterialIndent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
