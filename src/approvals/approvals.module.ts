import { Module } from '@nestjs/common';

import { AuditLogService } from '../auth/audit-log.service';
import { UsersModule } from '../users/users.module';
import { ApprovalsController } from './approvals.controller';
import { ApprovalService } from './approvals.service';
import { ChainsService } from './chains.service';

/**
 * The approval spine (feature 016).
 *
 * Exports `ApprovalService`, which is the **only** way another module may interact with
 * an approval. No module queries a spine table and the spine queries no module's tables
 * — Principle I, and the reason the spine references the items it governs by an opaque
 * `(entityType, entityId)` pair it can never dereference (research.md §1).
 *
 * `UsersModule` is imported for one question the spine cannot answer itself: which active
 * accounts hold the role a level resolves to. `shared.User` belongs to `UsersModule` and
 * the role assignments live in `settings`, so the answer comes through
 * `UsersService.findActiveHoldersOfRole` rather than a cross-schema read.
 *
 * `AuditLogService` is declared here rather than imported from `AuthModule`, matching
 * every other feature module: the service is stateless and `AuthModule` does not export
 * it.
 *
 * `ApprovalsController` carries no blanket permission. Authority to decide is the chain's
 * slot mapping, resolved per item; only the chain-configuration endpoints are guarded,
 * by `SETTINGS`, because defining a chain is a settings act rather than an approval one.
 */
@Module({
  imports: [UsersModule],
  controllers: [ApprovalsController],
  providers: [ApprovalService, ChainsService, AuditLogService],
  exports: [ApprovalService, ChainsService],
})
export class ApprovalsModule {}
