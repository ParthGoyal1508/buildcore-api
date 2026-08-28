import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
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
  @ApiOkResponse({ type: UserResponseDto })
  async changePassword(
    @UserEntity() user: AuthenticatedUser,
    @Body() data: ChangePasswordDto,
  ): Promise<UserResponseDto> {
    const updated = await this.usersService.changePassword(user, data);
    return UserResponseDto.fromEntity(updated);
  }
}
