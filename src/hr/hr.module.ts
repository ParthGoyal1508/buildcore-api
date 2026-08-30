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
import { EmployeesService } from './employees/employees.service';
import { PunchController } from './punch/punch.controller';
import { PunchService } from './punch/punch.service';

/**
 * The `hr` module: the employee-facing My Workspace surface.
 *
 * Imports `SettingsModule` and `ProjectsModule` rather than querying their schemas,
 * per Principle I — the payroll lock day, shift duration, and site geofence all
 * arrive through those modules' exported services.
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
    PunchController,
    AttendanceExceptionsController,
  ],
  providers: [
    EmployeesService,
    ImageProcessingService,
    FaceEnrolmentService,
    PunchService,
    AuditLogService,
    { provide: BiometricsService, useClass: FaceApiBiometricsService },
  ],
  exports: [EmployeesService],
})
export class HrModule {}
