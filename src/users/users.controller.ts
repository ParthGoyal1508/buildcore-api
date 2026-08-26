import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
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
  me(@UserEntity() user: User): UserResponseDto {
    return UserResponseDto.fromEntity(user);
  }

  @Patch('me')
  @ApiOkResponse({ type: UserResponseDto })
  async updateMe(
    @UserEntity() user: User,
    @Body() data: UpdateUserDto,
  ): Promise<UserResponseDto> {
    const updated = await this.usersService.updateUser(user.id, data);
    return UserResponseDto.fromEntity(updated);
  }

  @Patch('me/password')
  @ApiOkResponse({ type: UserResponseDto })
  async changePassword(
    @UserEntity() user: User,
    @Body() data: ChangePasswordDto,
  ): Promise<UserResponseDto> {
    const updated = await this.usersService.changePassword(
      user.id,
      user.password,
      data,
    );
    return UserResponseDto.fromEntity(updated);
  }
}
