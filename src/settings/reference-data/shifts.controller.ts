import {
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CreateShiftDto, UpdateShiftDto } from './dto/shift.dto';
import { ReferenceDataService } from './reference-data.service';

/** Per-company Shift master (see ReferenceDataService for the shared CRUD). */
@ApiTags('settings/shifts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.EMPLOYEES)
@Controller('settings/shifts')
export class ShiftsController {
  constructor(private readonly referenceData: ReferenceDataService) {}

  @Get()
  @ApiOperation({ summary: "List this company's Shift entries" })
  @ApiQuery({
    name: 'companyId',
    required: false,
    description:
      'Narrows the list to one company. Honoured only for a caller holding CROSS_COMPANY_ACCESS; ignored for everyone else, who is always pinned to their own company.',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query('companyId') companyId?: string,
  ): Promise<Record<string, unknown>[]> {
    return this.referenceData.findAll('shift', caller, companyId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a Shift entry' })
  @ApiConflictResponse({ description: 'Name already used within this company' })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateShiftDto,
    @Ip() ipAddress: string,
  ): Promise<Record<string, unknown>> {
    return this.referenceData.create('shift', caller, dto, ipAddress);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a Shift entry' })
  @ApiConflictResponse({ description: 'Name already used within this company' })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateShiftDto,
    @Ip() ipAddress: string,
  ): Promise<Record<string, unknown>> {
    return this.referenceData.update('shift', caller, id, dto, ipAddress);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a Shift entry' })
  @ApiConflictResponse({
    description: 'Still referenced by an employee record',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ): Promise<void> {
    return this.referenceData.remove('shift', caller, id, ipAddress);
  }
}
