import { Module } from '@nestjs/common';

import { AuditLogService } from '../auth/audit-log.service';
import { BiometricsService } from '../hr/biometrics/biometrics.service';
import { FaceApiBiometricsService } from '../hr/biometrics/face-api-biometrics.service';
import { ImageProcessingService } from '../hr/biometrics/image-processing.service';
import { PartnersModule } from '../partners/partners.module';
import { ProjectsModule } from '../projects/projects.module';
import { SettingsModule } from '../settings/settings.module';
import { LabourRefsService } from './labour-refs.service';
import { LabourService } from './labour.service';
import { WageRateController } from './wage-rates/wage-rate.controller';
import { WageRateService } from './wage-rates/wage-rate.service';
import { SkillCategoriesController } from './skill-categories/skill-categories.controller';
import { LabourWorkerController } from './workers/labour-worker.controller';
import { LabourWorkerService } from './workers/labour-worker.service';
import { GangController } from './workers/gang.controller';
import { GangService } from './workers/gang.service';
import { MusterController } from './muster/muster.controller';
import { MusterService } from './muster/muster.service';
import { LabourAdvanceController } from './advances/labour-advance.controller';
import { LabourAdvanceService } from './advances/labour-advance.service';
import { PaymentSheetController } from './payment-sheets/payment-sheet.controller';
import { PaymentSheetService } from './payment-sheets/payment-sheet.service';
import { LabourReportsController } from './reports/labour-reports.controller';
import { LabourReportsService } from './reports/labour-reports.service';

/**
 * The `labour` module (feature 013): per-project wage rates, workers and gangs,
 * supervisor muster capture, muster approval, cash payment sheets with denomination
 * breakup and disbursement, labour advances, and reports.
 *
 * `SettingsModule`, `ProjectsModule`, and `PartnersModule` are imported rather than
 * their schemas queried (Principle I): skill categories / company labour settings,
 * site geofences, and contractor validation all arrive through those modules'
 * exported services. Biometric machinery is reused from feature 003 by binding the
 * same `BiometricsService` implementation here (FR-011), never reimplemented.
 *
 * `LabourService` is exported as the module's outward contract — the single method
 * feature 008's Project P&L reads labour cost through (FR-033).
 */
@Module({
  imports: [SettingsModule, ProjectsModule, PartnersModule],
  controllers: [
    WageRateController,
    SkillCategoriesController,
    LabourWorkerController,
    GangController,
    MusterController,
    LabourAdvanceController,
    PaymentSheetController,
    LabourReportsController,
  ],
  providers: [
    LabourRefsService,
    LabourService,
    WageRateService,
    LabourWorkerService,
    GangService,
    MusterService,
    LabourAdvanceService,
    PaymentSheetService,
    LabourReportsService,
    ImageProcessingService,
    AuditLogService,
    { provide: BiometricsService, useClass: FaceApiBiometricsService },
  ],
  exports: [LabourService],
})
export class LabourModule {}
