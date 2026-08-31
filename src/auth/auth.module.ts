import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { PasswordService } from './password.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { RefreshTokenService } from './refresh-token.service';
import { AuditLogService } from './audit-log.service';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { SecurityConfig } from '../common/configs/config.interface';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      useFactory: async (configService: ConfigService) => {
        const securityConfig = configService.get<SecurityConfig>('security');
        return {
          secret: securityConfig.jwtAccessSecret,
          signOptions: {
            expiresIn: securityConfig.expiresIn,
          },
        };
      },
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    JwtAuthGuard,
    PermissionsGuard,
    PasswordService,
    RefreshTokenService,
    AuditLogService,
  ],
  exports: [JwtAuthGuard, PermissionsGuard],
})
export class AuthModule {}
