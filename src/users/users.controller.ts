import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { PasswordChangeExempt } from '../common/decorators/password-change-exempt.decorator';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UserEntity } from '../common/decorators/user.decorator';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UserResponseDto } from './dto/user-response.dto';

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  // Exempt: the shell must be able to render who is signed in while they complete
  // the change (010 FR-017a).
  @PasswordChangeExempt()
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
  @ApiOkResponse({ type: UserResponseDto })
  async changePassword(
    @UserEntity() user: AuthenticatedUser,
    @Body() data: ChangePasswordDto,
  ): Promise<UserResponseDto> {
    const updated = await this.usersService.changePassword(user, data);
    return UserResponseDto.fromEntity(updated);
  }
}
