-- AlterEnum
ALTER TYPE "shared"."UserStatus" ADD VALUE 'pending';

-- AlterTable
ALTER TABLE "shared"."User" ADD COLUMN     "displayName" TEXT,
ALTER COLUMN "username" DROP NOT NULL,
ALTER COLUMN "password" DROP NOT NULL;

-- CreateTable
CREATE TABLE "shared"."InviteToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InviteToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InviteToken_tokenHash_key" ON "shared"."InviteToken"("tokenHash");

-- CreateIndex
CREATE INDEX "InviteToken_userId_createdAt_idx" ON "shared"."InviteToken"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "shared"."InviteToken" ADD CONSTRAINT "InviteToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "shared"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
