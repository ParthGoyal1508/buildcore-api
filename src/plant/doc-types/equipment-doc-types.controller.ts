import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import {
  CreateEquipmentDocTypeDto,
  UpdateEquipmentDocTypeDto,
} from '../../settings/machinery-masters/dto/machinery-masters.dto';
import { EquipmentDocTypesService } from '../../settings/machinery-masters/equipment-doc-types.service';

/**
 * Equipment document types — a `settings` master on a `/plant` route, for the same
 * reasons as `EquipmentCategoriesController`.
 *
 * No delete: `alertDays` on this master is what every historical document's expiry
 * flag is computed from, and removing a type would leave those documents unable to
 * say what they are. Set `active: false` instead.
 */
@ApiTags('Plant')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.SETTINGS)
@Controller('plant/doc-types')
export class EquipmentDocTypesController {
  constructor(private readonly docTypes: EquipmentDocTypesService) {}

  @Get()
  @ApiOperation({ summary: 'Every equipment document type' })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query('companyId') companyId?: string,
  ) {
    return this.docTypes.findAll(caller, companyId);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a document type',
    description:
      "`alertDays` is this type's own expiry warning window — the register flags a " +
      'document that many days before it lapses.',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateEquipmentDocTypeDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.docTypes.create(caller, dto, ipAddress, companyId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a document type' })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateEquipmentDocTypeDto,
    @Ip() ipAddress: string,
  ) {
    return this.docTypes.update(caller, id, dto, ipAddress);
  }
}
