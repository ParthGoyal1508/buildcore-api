import { Module } from '@nestjs/common';
import { AuditLogService } from '../auth/audit-log.service';
import { PasswordService } from '../auth/password.service';
import { HrModule } from '../hr/hr.module';
import { InvitesController } from './invites/invites.controller';
import { InvitesService } from './invites/invites.service';
import { TokenService } from './invites/token.service';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';

/**
 * Account creation: the invite flow that features 001 and 002 both deferred.
 *
 * `UsersService` is exported because this module owns the account lifecycle while
 * 002 owns the screens for it — 002's `/settings/users` calls in here rather than
 * reimplementing status transitions it would have to keep in sync (research.md §8).
 *
 * `HrModule` is imported for the employee link; `EmailService` arrives from the
 * global `EmailModule`.
 */
@Module({
  imports: [HrModule],
  controllers: [UsersController, InvitesController],
  providers: [
    UsersService,
    InvitesService,
    TokenService,
    PasswordService,
    AuditLogService,
  ],
  exports: [UsersService],
})
export class AccountCreationModule {}
