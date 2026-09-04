-- Recruitment & Onboarding (feature 011): the `recruitment` schema (11 tables),
-- two `settings` reference masters (KitItem, LetterTemplate), the RECRUITMENT /
-- RECRUITMENT_APPROVE permissions, the REQUISITION code series, and the recruitment
-- audit entity types.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "recruitment";

-- CreateEnum
CREATE TYPE "settings"."LetterType" AS ENUM ('offer', 'appointment', 'confirmation', 'relieving', 'experience');

-- CreateEnum
CREATE TYPE "recruitment"."RequisitionEmploymentType" AS ENUM ('permanent', 'contract', 'walk_in');
CREATE TYPE "recruitment"."RequisitionStatus" AS ENUM ('draft', 'pending_approval', 'open', 'rejected', 'closed');
CREATE TYPE "recruitment"."CandidateSource" AS ENUM ('referral', 'agency', 'walk_in', 'portal', 'internal');
CREATE TYPE "recruitment"."CandidateStage" AS ENUM ('applied', 'shortlisted', 'interviewing', 'selected', 'offer_issued', 'offer_accepted', 'joined', 'rejected', 'no_show');
CREATE TYPE "recruitment"."InterviewRoundType" AS ENUM ('telephonic', 'technical', 'hr', 'managerial', 'final');
CREATE TYPE "recruitment"."InterviewMode" AS ENUM ('in_person', 'phone', 'video');
CREATE TYPE "recruitment"."InterviewStatus" AS ENUM ('scheduled', 'completed', 'cancelled');
CREATE TYPE "recruitment"."InterviewOutcome" AS ENUM ('recommend', 'hold', 'reject');
CREATE TYPE "recruitment"."OfferStatus" AS ENUM ('draft', 'issued', 'accepted', 'declined', 'superseded');
CREATE TYPE "recruitment"."OnboardingItemType" AS ENUM ('document', 'kit', 'induction');
CREATE TYPE "recruitment"."OnboardingItemStatus" AS ENUM ('pending', 'completed', 'waived');
CREATE TYPE "recruitment"."ResignationReasonCategory" AS ENUM ('better_opportunity', 'personal', 'relocation', 'health', 'compensation', 'work_environment', 'other');
CREATE TYPE "recruitment"."ResignationStatus" AS ENUM ('submitted', 'accepted', 'withdrawn');

-- AlterEnum
ALTER TYPE "settings"."Permission" ADD VALUE 'RECRUITMENT';
ALTER TYPE "settings"."Permission" ADD VALUE 'RECRUITMENT_APPROVE';

-- AlterEnum
ALTER TYPE "settings"."CodeSeriesType" ADD VALUE 'REQUISITION';

-- AlterEnum
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'REQUISITION';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'CANDIDATE';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'INTERVIEW';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'OFFER';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'ONBOARDING_ITEM';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'LETTER';
ALTER TYPE "shared"."AuditEntityType" ADD VALUE 'RESIGNATION';

-- CreateTable
CREATE TABLE "settings"."KitItem" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "linkedInventoryItemId" TEXT,
    "defaultQuantity" INTEGER NOT NULL DEFAULT 1,
    "issuedByDefault" BOOLEAN NOT NULL DEFAULT true,
    "isRecoverableAtExit" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KitItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings"."LetterTemplate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "letterType" "settings"."LetterType" NOT NULL,
    "name" TEXT NOT NULL,
    "bodyTemplate" TEXT NOT NULL,
    "letterheadAssetId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LetterTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment"."Requisition" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "requisitionCode" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "designationId" TEXT NOT NULL,
    "positionCount" INTEGER NOT NULL,
    "filledPositions" INTEGER NOT NULL DEFAULT 0,
    "employmentType" "recruitment"."RequisitionEmploymentType" NOT NULL,
    "projectId" TEXT,
    "siteId" TEXT,
    "targetJoiningDate" DATE NOT NULL,
    "budgetedCtcMin" DECIMAL(14,2) NOT NULL,
    "budgetedCtcMax" DECIMAL(14,2) NOT NULL,
    "justification" TEXT NOT NULL,
    "status" "recruitment"."RequisitionStatus" NOT NULL DEFAULT 'draft',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "Requisition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment"."Candidate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "requisitionId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "totalExperienceYears" DECIMAL(4,1) NOT NULL,
    "currentEmployer" TEXT,
    "currentCtc" DECIMAL(14,2),
    "expectedCtc" DECIMAL(14,2),
    "source" "recruitment"."CandidateSource" NOT NULL,
    "referredByEmployeeId" TEXT,
    "resumeRef" TEXT,
    "stage" "recruitment"."CandidateStage" NOT NULL DEFAULT 'applied',
    "employeeId" TEXT,
    "previousCandidateId" TEXT,
    "rejectionReason" TEXT,
    "noShowReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "Candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment"."CandidateStageHistory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "fromStage" "recruitment"."CandidateStage",
    "toStage" "recruitment"."CandidateStage" NOT NULL,
    "actorId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "remarks" TEXT,

    CONSTRAINT "CandidateStageHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment"."Interview" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "roundNumber" INTEGER NOT NULL,
    "roundType" "recruitment"."InterviewRoundType" NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "mode" "recruitment"."InterviewMode" NOT NULL,
    "location" TEXT,
    "status" "recruitment"."InterviewStatus" NOT NULL DEFAULT 'scheduled',
    "rescheduleCount" INTEGER NOT NULL DEFAULT 0,
    "rescheduleHistory" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "Interview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment"."InterviewInterviewer" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "interviewId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,

    CONSTRAINT "InterviewInterviewer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment"."InterviewFeedback" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "interviewId" TEXT NOT NULL,
    "interviewerEmployeeId" TEXT NOT NULL,
    "outcome" "recruitment"."InterviewOutcome" NOT NULL,
    "score" INTEGER NOT NULL,
    "comments" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InterviewFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment"."Offer" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "designationId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "offeredCtc" DECIMAL(14,2) NOT NULL,
    "salaryBreakup" JSONB NOT NULL,
    "proposedJoiningDate" DATE NOT NULL,
    "confirmedJoiningDate" DATE,
    "probationMonths" INTEGER NOT NULL,
    "noticePeriodDays" INTEGER NOT NULL,
    "reportingManagerEmployeeId" TEXT NOT NULL,
    "outsideBudget" BOOLEAN NOT NULL DEFAULT false,
    "status" "recruitment"."OfferStatus" NOT NULL DEFAULT 'draft',
    "letterId" TEXT,
    "acceptedOn" DATE,
    "declineReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment"."OnboardingChecklist" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingChecklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment"."OnboardingItem" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "checklistId" TEXT NOT NULL,
    "itemType" "recruitment"."OnboardingItemType" NOT NULL,
    "documentTypeId" TEXT,
    "kitItemId" TEXT,
    "label" TEXT NOT NULL,
    "status" "recruitment"."OnboardingItemStatus" NOT NULL DEFAULT 'pending',
    "completedBy" TEXT,
    "completedAt" TIMESTAMP(3),
    "waiverReason" TEXT,
    "linkedIssueId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment"."GeneratedLetter" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "letterType" "settings"."LetterType" NOT NULL,
    "employeeId" TEXT,
    "candidateId" TEXT,
    "templateId" TEXT NOT NULL,
    "renderedRef" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isSuperseded" BOOLEAN NOT NULL DEFAULT false,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedBy" TEXT,

    CONSTRAINT "GeneratedLetter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment"."Resignation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "resignationDate" DATE NOT NULL,
    "reasonCategory" "recruitment"."ResignationReasonCategory" NOT NULL,
    "reasonDetail" TEXT NOT NULL,
    "noticePeriodDays" INTEGER NOT NULL,
    "expectedLastWorkingDay" DATE NOT NULL,
    "agreedLastWorkingDay" DATE,
    "noticeWaiverDays" INTEGER,
    "waiverReason" TEXT,
    "status" "recruitment"."ResignationStatus" NOT NULL DEFAULT 'submitted',
    "withdrawReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "Resignation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KitItem_companyId_name_key" ON "settings"."KitItem"("companyId", "name");
CREATE INDEX "KitItem_companyId_idx" ON "settings"."KitItem"("companyId");

-- CreateIndex
CREATE INDEX "LetterTemplate_companyId_idx" ON "settings"."LetterTemplate"("companyId");
CREATE INDEX "LetterTemplate_companyId_letterType_idx" ON "settings"."LetterTemplate"("companyId", "letterType");
-- At most one active template per (companyId, letterType) — FR-021.
CREATE UNIQUE INDEX "LetterTemplate_companyId_letterType_active_key" ON "settings"."LetterTemplate"("companyId", "letterType") WHERE "isActive";

-- CreateIndex
CREATE UNIQUE INDEX "Requisition_companyId_requisitionCode_key" ON "recruitment"."Requisition"("companyId", "requisitionCode");
CREATE INDEX "Requisition_companyId_idx" ON "recruitment"."Requisition"("companyId");
CREATE INDEX "Requisition_companyId_status_idx" ON "recruitment"."Requisition"("companyId", "status");
CREATE INDEX "Requisition_companyId_departmentId_idx" ON "recruitment"."Requisition"("companyId", "departmentId");

-- CreateIndex
CREATE INDEX "Candidate_companyId_idx" ON "recruitment"."Candidate"("companyId");
CREATE INDEX "Candidate_companyId_requisitionId_idx" ON "recruitment"."Candidate"("companyId", "requisitionId");
CREATE INDEX "Candidate_companyId_stage_idx" ON "recruitment"."Candidate"("companyId", "stage");

-- CreateIndex
CREATE INDEX "CandidateStageHistory_companyId_idx" ON "recruitment"."CandidateStageHistory"("companyId");
CREATE INDEX "CandidateStageHistory_candidateId_idx" ON "recruitment"."CandidateStageHistory"("candidateId");

-- CreateIndex
CREATE UNIQUE INDEX "Interview_candidateId_roundNumber_key" ON "recruitment"."Interview"("candidateId", "roundNumber");
CREATE INDEX "Interview_companyId_idx" ON "recruitment"."Interview"("companyId");
CREATE INDEX "Interview_companyId_status_idx" ON "recruitment"."Interview"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InterviewInterviewer_interviewId_employeeId_key" ON "recruitment"."InterviewInterviewer"("interviewId", "employeeId");
CREATE INDEX "InterviewInterviewer_companyId_idx" ON "recruitment"."InterviewInterviewer"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "InterviewFeedback_interviewId_interviewerEmployeeId_key" ON "recruitment"."InterviewFeedback"("interviewId", "interviewerEmployeeId");
CREATE INDEX "InterviewFeedback_companyId_idx" ON "recruitment"."InterviewFeedback"("companyId");

-- CreateIndex
CREATE INDEX "Offer_companyId_idx" ON "recruitment"."Offer"("companyId");
CREATE INDEX "Offer_companyId_candidateId_idx" ON "recruitment"."Offer"("companyId", "candidateId");

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingChecklist_companyId_employeeId_key" ON "recruitment"."OnboardingChecklist"("companyId", "employeeId");
CREATE INDEX "OnboardingChecklist_companyId_idx" ON "recruitment"."OnboardingChecklist"("companyId");

-- CreateIndex
CREATE INDEX "OnboardingItem_companyId_idx" ON "recruitment"."OnboardingItem"("companyId");
CREATE INDEX "OnboardingItem_checklistId_idx" ON "recruitment"."OnboardingItem"("checklistId");

-- CreateIndex
CREATE INDEX "GeneratedLetter_companyId_idx" ON "recruitment"."GeneratedLetter"("companyId");
CREATE INDEX "GeneratedLetter_companyId_letterType_employeeId_idx" ON "recruitment"."GeneratedLetter"("companyId", "letterType", "employeeId");
CREATE INDEX "GeneratedLetter_companyId_letterType_candidateId_idx" ON "recruitment"."GeneratedLetter"("companyId", "letterType", "candidateId");

-- CreateIndex
CREATE INDEX "Resignation_companyId_idx" ON "recruitment"."Resignation"("companyId");
CREATE INDEX "Resignation_companyId_employeeId_idx" ON "recruitment"."Resignation"("companyId", "employeeId");
CREATE INDEX "Resignation_companyId_status_idx" ON "recruitment"."Resignation"("companyId", "status");

-- AddForeignKey
ALTER TABLE "settings"."KitItem" ADD CONSTRAINT "KitItem_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "settings"."LetterTemplate" ADD CONSTRAINT "LetterTemplate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "settings"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment"."Candidate" ADD CONSTRAINT "Candidate_requisitionId_fkey" FOREIGN KEY ("requisitionId") REFERENCES "recruitment"."Requisition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recruitment"."CandidateStageHistory" ADD CONSTRAINT "CandidateStageHistory_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "recruitment"."Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recruitment"."Interview" ADD CONSTRAINT "Interview_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "recruitment"."Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recruitment"."InterviewInterviewer" ADD CONSTRAINT "InterviewInterviewer_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "recruitment"."Interview"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recruitment"."InterviewFeedback" ADD CONSTRAINT "InterviewFeedback_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "recruitment"."Interview"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recruitment"."Offer" ADD CONSTRAINT "Offer_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "recruitment"."Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recruitment"."OnboardingItem" ADD CONSTRAINT "OnboardingItem_checklistId_fkey" FOREIGN KEY ("checklistId") REFERENCES "recruitment"."OnboardingChecklist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
