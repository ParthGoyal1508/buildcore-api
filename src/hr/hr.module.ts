import { Module } from '@nestjs/common';
import { AuditLogService } from '../auth/audit-log.service';
import { ProjectsModule } from '../projects/projects.module';
import { SettingsModule } from '../settings/settings.module';
import { AttendanceExceptionsController } from './attendance-exceptions/attendance-exceptions.controller';
import { BiometricsService } from './biometrics/biometrics.service';
import { FaceApiBiometricsService } from './biometrics/face-api-biometrics.service';
import { FaceEnrolmentController } from './biometrics/face-enrolment.controller';
import { FaceEnrolmentService } from './biometrics/face-enrolment.service';
import { ImageProcessingService } from './biometrics/image-processing.service';
import { ReEnrolmentAdminController } from './biometrics/re-enrolment-admin.controller';
import { EmployeesService } from './employees/employees.service';
import { LeaveAdminController } from './leave/leave-admin.controller';
import { LeaveController } from './leave/leave.controller';
import { LeaveService } from './leave/leave.service';
import { AttendanceHistoryService } from './punch/attendance-history.service';
import { PunchController } from './punch/punch.controller';
import { PunchService } from './punch/punch.service';
import { ReimbursementController } from './reimbursements/reimbursement.controller';
import { ReimbursementService } from './reimbursements/reimbursement.service';

/**
 * The `hr` module: the employee-facing My Workspace surface.
 *
 * Imports `SettingsModule` and `ProjectsModule` rather than querying their schemas,
 * per Principle I — the payroll lock day, shift duration, site geofence, and
 * reimbursement categories all arrive through those modules' exported services.
 *
 * `BiometricsService` is bound to the face-api implementation here. Because callers
 * depend on the abstract class, the e2e suite can override this one binding with a
 * deterministic fake and exercise every attendance path without running real
 * inference against real photographs.
 */
@Module({
  imports: [SettingsModule, ProjectsModule],
  controllers: [
    FaceEnrolmentController,
    ReEnrolmentAdminController,
    PunchController,
    AttendanceExceptionsController,
    LeaveController,
    LeaveAdminController,
    ReimbursementController,
  ],
  providers: [
    EmployeesService,
    ImageProcessingService,
    FaceEnrolmentService,
    PunchService,
    AttendanceHistoryService,
    LeaveService,
    ReimbursementService,
    AuditLogService,
    { provide: BiometricsService, useClass: FaceApiBiometricsService },
  ],
  // `LeaveService` is exported alongside `EmployeesService` so payroll-side
  // features can ask "which dates was this employee on approved leave" without
  // reaching into `hr.LeaveApplication` themselves.
  exports: [EmployeesService, LeaveService],
})
export class HrModule {}
