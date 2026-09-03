import { forwardRef, Module } from '@nestjs/common';
import { AuditLogService } from '../auth/audit-log.service';
import { ProjectsModule } from '../projects/projects.module';
import { SettingsModule } from '../settings/settings.module';
import { AttendanceAdminController } from './attendance/attendance-admin.controller';
import { AttendanceAdminService } from './attendance/attendance-admin.service';
import { AttendanceImportController } from './attendance/attendance-import.controller';
import { AttendanceImportService } from './attendance/attendance-import.service';
import { HolidaysController } from './attendance/holidays.controller';
import { AttendanceExceptionsController } from './attendance-exceptions/attendance-exceptions.controller';
import { BiometricsService } from './biometrics/biometrics.service';
import { FaceApiBiometricsService } from './biometrics/face-api-biometrics.service';
import { FaceEnrolmentController } from './biometrics/face-enrolment.controller';
import { FaceEnrolmentService } from './biometrics/face-enrolment.service';
import { ImageProcessingService } from './biometrics/image-processing.service';
import { ReEnrolmentAdminController } from './biometrics/re-enrolment-admin.controller';
import { EmployeeDocumentsController } from './employees/documents/employee-documents.controller';
import { EmployeeDocumentsService } from './employees/documents/employee-documents.service';
import { EmployeesController } from './employees/employees.controller';
import { ExitService } from './offboarding/exit.service';
import { ReEnrolmentRequestsAdminController } from './re-enrolment-requests/re-enrolment-requests-admin.controller';
import { EmployeesService } from './employees/employees.service';
import { HolidaysService } from './holidays/holidays.service';
import { PiiCipherService } from './employees/pii-cipher.service';
import { PiiMaskingInterceptor } from './employees/pii-masking.interceptor';
import { LeaveAdminController } from './leave/leave-admin.controller';
import { LeaveHrAdminController } from './leave/leave-hr-admin.controller';
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
  // `forwardRef` because 008 made this edge bidirectional: `projects` now needs
  // `EmployeesService` for its site-delete guard and project roster, while `hr`
  // still needs `SitesService` for punch geofencing. See projects.module.ts.
  imports: [SettingsModule, forwardRef(() => ProjectsModule)],
  controllers: [
    EmployeesController,
    AttendanceAdminController,
    AttendanceImportController,
    HolidaysController,
    EmployeeDocumentsController,
    FaceEnrolmentController,
    ReEnrolmentAdminController,
    PunchController,
    AttendanceExceptionsController,
    LeaveController,
    LeaveAdminController,
    LeaveHrAdminController,
    ReEnrolmentRequestsAdminController,
    ReimbursementController,
  ],
  providers: [
    EmployeesService,
    EmployeeDocumentsService,
    AttendanceAdminService,
    AttendanceImportService,
    ExitService,
    HolidaysService,
    PiiCipherService,
    PiiMaskingInterceptor,
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
  exports: [
    EmployeesService,
    EmployeeDocumentsService,
    AttendanceAdminService,
    AttendanceImportService,
    ExitService,
    LeaveService,
    PiiCipherService,
    HolidaysService,
    // Exported for `payroll`, whose engine resolves each employee's period
    // attendance through the same computation the employee's own screen uses —
    // payroll and the employee must never disagree about whether a day was worked.
    AttendanceHistoryService,
    // Exported for `payroll`, whose F&F flow deactivates the employee once the
    // settlement run is processed (FR-034).
    ExitService,
  ],
})
export class HrModule {}
