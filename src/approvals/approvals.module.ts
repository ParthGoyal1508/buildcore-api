import { Module } from '@nestjs/common';

import { AuditLogService } from '../auth/audit-log.service';
import { UsersModule } from '../users/users.module';
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
 * There is no controller yet. Phase 1 of this feature deliberately ships the spine with
 * no HTTP surface and no consumers, so it can be proven in isolation before any existing
 * behaviour changes; `/approvals/*` arrives with Phase 4 (tasks T044–T046).
 */
@Module({
  imports: [UsersModule],
  providers: [ApprovalService, ChainsService, AuditLogService],
  exports: [ApprovalService, ChainsService],
})
export class ApprovalsModule {}
