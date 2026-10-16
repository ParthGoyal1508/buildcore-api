import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { PasswordService } from '../auth/password.service';
import { AuditLogService } from '../auth/audit-log.service';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { ChangePasswordService } from './change-password.service';
import { AccountDeactivationService } from './account-deactivation.service';

@Module({
  controllers: [UsersController],
  providers: [
    UsersService,
    PasswordService,
    ChangePasswordService,
    AccountDeactivationService,
    RefreshTokenService,
    AuditLogService,
  ],
  // Exported so SettingsModule can reach `shared.User` through this module's
  // service rather than querying another schema's tables directly (Principle I).
  exports: [UsersService, AccountDeactivationService],
})
export class UsersModule {}
