import { Global, Module } from '@nestjs/common';

import { CompanySelectionService } from './company-selection.service';

/**
 * Makes the company selection resolvable from the JWT strategy (019 FR-008).
 *
 * `@Global` for a structural reason, not convenience. The selection has to be resolved in
 * `JwtStrategy.validate` so that every `rlsContextFor(caller)` in the codebase respects it
 * without each of them changing — but `AuthModule` sits below `SettingsModule` and importing
 * upward would make the dependency a cycle. The same shape as `PermissionRefusalModule`, and
 * for the same reason: a thing the authentication layer needs cannot live above it.
 *
 * The controller stays in `SettingsModule`, which is where its routes belong.
 */
@Global()
@Module({
  providers: [CompanySelectionService],
  exports: [CompanySelectionService],
})
export class CompanySelectionModule {}
