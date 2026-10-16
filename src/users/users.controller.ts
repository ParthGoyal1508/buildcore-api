import {
  Body,
  Controller,
  Get,
  Header,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { PasswordChangeExempt } from '../common/decorators/password-change-exempt.decorator';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UserEntity } from '../common/decorators/user.decorator';
import { UsersService } from './users.service';
import { ChangePasswordService } from './change-password.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { SelfService } from '../common/decorators/route-access.decorator';

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
// 019 FR-005: self-service — the caller's own profile and password, resolved from
// their own token. A permission would be wrong: every employee would need it, so it
// would grant nothing.
@SelfService()
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly changePasswordService: ChangePasswordService,
  ) {}

  @Get('me')
  // Exempt: the shell must be able to render who is signed in while they complete
  // the change (010 FR-017a).
  @PasswordChangeExempt()
  // Never stored by a browser cache or a service worker's HTTP cache (029 FR-050): it is who is
  // signed in, and a cached copy outlives a sign-out on a shared phone.
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: UserResponseDto })
  me(@UserEntity() user: AuthenticatedUser): UserResponseDto {
    return UserResponseDto.fromEntity(user);
  }

  @Patch('me')
  @ApiOkResponse({ type: UserResponseDto })
  async updateMe(
    @UserEntity() user: AuthenticatedUser,
    @Body() data: UpdateUserDto,
  ): Promise<UserResponseDto> {
    const updated = await this.usersService.updateUser(user, data);
    return UserResponseDto.fromEntity(updated);
  }

  @Patch('me/password')
  // Exempt: this is the way out of the forced change (010 FR-017a).
  @PasswordChangeExempt()
  // Sign-in's per-address allowance: checking the current password is a guessing surface
  // reachable from any session left open (029 FR-008).
  @UseGuards(ThrottlerGuard)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: UserResponseDto })
  async changePassword(
    @UserEntity() user: AuthenticatedUser,
    @Body() data: ChangePasswordDto,
    @Req() req: Request,
  ): Promise<UserResponseDto> {
    const updated = await this.changePasswordService.changePassword(
      user,
      data,
      req.ip ?? 'unknown',
    );
    return UserResponseDto.fromEntity(updated);
  }
}
