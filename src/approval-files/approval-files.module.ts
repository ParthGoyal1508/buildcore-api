import { Module } from '@nestjs/common';

import { ApprovalsModule } from '../approvals/approvals.module';
import { HrModule } from '../hr/hr.module';
import { LettersModule } from '../letters/letters.module';
import { PayrollModule } from '../payroll/payroll.module';
import { ProjectsModule } from '../projects/projects.module';
import { ApprovalFilesController } from './approval-files.controller';
import { ApprovalFilesService } from './approval-files.service';

/**
 * Approval files (2026-10-20). A leaf above the spine and the modules whose items it governs, so
 * neither has to depend on the other — see `ApprovalFilesService`.
 */
@Module({
  imports: [
    ApprovalsModule,
    HrModule,
    LettersModule,
    PayrollModule,
    ProjectsModule,
  ],
  controllers: [ApprovalFilesController],
  providers: [ApprovalFilesService],
})
export class ApprovalFilesModule {}
