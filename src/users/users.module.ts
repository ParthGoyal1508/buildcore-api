import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { PasswordService } from '../auth/password.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService, PasswordService],
  // Exported so SettingsModule can reach `shared.User` through this module's
  // service rather than querying another schema's tables directly (Principle I).
  exports: [UsersService],
})
export class UsersModule {}
