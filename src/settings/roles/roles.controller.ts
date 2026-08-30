import {
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { RoleWithAssignedCount, RolesService } from './roles.service';

@ApiTags('settings/roles')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.USER_MANAGEMENT)
@Controller('settings/roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @ApiOperation({
    summary: 'List roles with their assigned-user counts (FR-009)',
  })
  async findAll(): Promise<RoleWithAssignedCount[]> {
    return this.rolesService.findAll();
  }

  @Post()
  @ApiOperation({ summary: 'Create a custom role' })
  @ApiConflictResponse({ description: 'A role with that name already exists' })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateRoleDto,
    @Ip() ipAddress: string,
  ): Promise<RoleWithAssignedCount> {
    return this.rolesService.create(caller, dto, ipAddress);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a role' })
  @ApiForbiddenResponse({
    description: 'The Super Admin role is protected (FR-008)',
  })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
    @Ip() ipAddress: string,
  ): Promise<RoleWithAssignedCount> {
    return this.rolesService.update(caller, id, dto, ipAddress);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a role',
    description:
      'Clears the role from every account holding it; those accounts lose its access on their next request (FR-010, FR-012).',
  })
  @ApiOkResponse({
    description: 'Deleted, with the number of assignments cleared',
  })
  @ApiForbiddenResponse({
    description: 'The Super Admin role is protected (FR-008)',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ): Promise<{ clearedAssignments: number }> {
    return this.rolesService.remove(caller, id, ipAddress);
  }
}
