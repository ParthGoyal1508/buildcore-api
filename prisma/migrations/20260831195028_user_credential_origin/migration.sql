-- CreateEnum
CREATE TYPE "shared"."CredentialOrigin" AS ENUM ('invite', 'admin_direct', 'admin_reset');

-- AlterTable
ALTER TABLE "shared"."User" ADD COLUMN     "credentialOrigin" "shared"."CredentialOrigin" NOT NULL DEFAULT 'invite';
