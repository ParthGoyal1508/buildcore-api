import { Module } from '@nestjs/common';

import { AuditLogService } from '../auth/audit-log.service';
import { HrModule } from '../hr/hr.module';
import { SettingsModule } from '../settings/settings.module';
import { RecruitmentRefsService } from './recruitment-refs.service';
import { RecruitmentService } from './recruitment.service';
import { RequisitionController } from './requisitions/requisition.controller';
import { RequisitionService } from './requisitions/requisition.service';
import { CandidateController } from './candidates/candidate.controller';
import { CandidateService } from './candidates/candidate.service';
import { InterviewController } from './interviews/interview.controller';
import { InterviewService } from './interviews/interview.service';
import { OfferController } from './offers/offer.controller';
import { OfferService } from './offers/offer.service';
import { JoiningController } from './joining/joining.controller';
import { JoiningService } from './joining/joining.service';
import { OnboardingController } from './onboarding/onboarding.controller';
import { OnboardingService } from './onboarding/onboarding.service';
import { LetterController } from './letters/letter.controller';
import { LetterService } from './letters/letter.service';
import { ResignationController } from './resignations/resignation.controller';
import { ResignationService } from './resignations/resignation.service';
import { RecruitmentReportsController } from './reports/recruitment-reports.controller';
import { RecruitmentReportsService } from './reports/recruitment-reports.service';

/**
 * The `recruitment` module (feature 011): requisitions, candidate pipeline,
 * interviews, offers, joining, onboarding, letters, and resignations.
 *
 * `SettingsModule` and `HrModule` are imported rather than their schemas queried
 * (Principle I): employee creation and document verification go through `hr`, and
 * document types / kit items / letter templates / code series / company name through
 * `settings`. `RecruitmentService` is exported as the seam feature 005's exit and
 * F&F flows read this module through (FR-065).
 */
@Module({
  imports: [SettingsModule, HrModule],
  controllers: [
    RequisitionController,
    CandidateController,
    InterviewController,
    OfferController,
    JoiningController,
    OnboardingController,
    LetterController,
    ResignationController,
    RecruitmentReportsController,
  ],
  providers: [
    RecruitmentRefsService,
    RecruitmentService,
    RequisitionService,
    CandidateService,
    InterviewService,
    OfferService,
    JoiningService,
    OnboardingService,
    LetterService,
    ResignationService,
    RecruitmentReportsService,
    AuditLogService,
  ],
  exports: [RecruitmentService],
})
export class RecruitmentModule {}
