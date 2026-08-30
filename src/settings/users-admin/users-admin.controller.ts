import {
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { UserSummary } from '../../users/user-summary';
import { UpdateUserAccountDto } from './dto/update-user.dto';
import { UsersAdminService } from './users-admin.service';

/**
 * Account *creation* is deliberately absent: new accounts come only from feature
 * 010's invite flow (`POST /account-creation/users`), never from here.
 */
@ApiTags('settings/users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.USER_MANAGEMENT)
@Controller('settings/users')
export class UsersAdminController {
  constructor(private readonly usersAdminService: UsersAdminService) {}

  @Get()
  @ApiOperation({ summary: "List accounts in the caller's company (FR-013)" })
  @ApiForbiddenResponse({
    description: 'Caller is not a Super Admin or HO User',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
  ): Promise<UserSummary[]> {
    return this.usersAdminService.findAll(caller);
  }

  @Patch(':id')
  @ApiOperation({ summary: "Change an account's role or status (FR-014)" })
  @ApiConflictResponse({
    description: 'Would leave zero active Super Admin accounts (FR-016)',
  })
  @ApiForbiddenResponse({
    description: 'Caller is not a Super Admin or HO User',
  })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateUserAccountDto,
    @Ip() ipAddress: string,
  ): Promise<UserSummary> {
    return this.usersAdminService.update(caller, id, dto, ipAddress);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an account (FR-015)' })
  @ApiConflictResponse({
    description: 'Deleting the last active Super Admin (FR-016)',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ): Promise<void> {
    return this.usersAdminService.remove(caller, id, ipAddress);
  }
}
