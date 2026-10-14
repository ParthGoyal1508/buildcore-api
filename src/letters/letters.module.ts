import { Module } from '@nestjs/common';

import { ApprovalsModule } from '../approvals/approvals.module';
import { AuditLogService } from '../auth/audit-log.service';
import { SettingsModule } from '../settings/settings.module';
import { LettersController } from './letters.controller';
import { LetterRecordSources } from './letter-record-sources';
import { LettersService } from './letters.service';

/**
 * Letters (017 US3–US6).
 *
 * Owns `shared.IssuedLetter`, which Phase 5 moved out of `recruitment` precisely so this
 * module could exist. It imports `SettingsModule` for kinds, templates, signatories and
 * document types — all `settings`-schema masters it reaches through exported service
 * methods rather than by querying (Principle I) — and `ApprovalsModule` for the 016 gate
 * it consumes and does not reimplement.
 *
 * It imports **no business module**. `partners`, `projects` and `inventory` are absent
 * on purpose: a letter addresses `(subjectType, subjectId)` opaquely and never resolves
 * it, and `letters-boundary.spec.ts` asserts that rather than trusting this comment.
 */
@Module({
  imports: [SettingsModule, ApprovalsModule],
  controllers: [LettersController],
  providers: [LettersService, LetterRecordSources, AuditLogService],
  // Exported so project, candidate and vendor screens list their letters through a
  // service method instead of reading `shared.IssuedLetter` themselves (T062).
  //
  // `LetterRecordSources` is exported the other way round: `hr` and `recruitment` import
  // this module to *register into* it, which is how a letter pre-fills from an employee
  // without this module importing either of them (2026-10-13).
  exports: [LettersService, LetterRecordSources],
})
export class LettersModule {}
