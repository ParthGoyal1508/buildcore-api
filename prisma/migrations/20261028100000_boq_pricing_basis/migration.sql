-- CreateEnum
CREATE TYPE "projects"."BoqPricingBasis" AS ENUM ('percentage', 'item_rate');

-- AlterTable
ALTER TABLE "projects"."BOQTaskItem" ADD COLUMN     "pricingBasis" "projects"."BoqPricingBasis" NOT NULL DEFAULT 'percentage';
