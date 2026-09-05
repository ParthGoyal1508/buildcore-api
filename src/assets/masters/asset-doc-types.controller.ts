import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
import { AssetDocTypesService } from '../../settings/asset-masters/asset-doc-types.service';
import {
  CreateAssetDocTypeDto,
  UpdateAssetDocTypeDto,
} from '../../settings/asset-masters/dto/asset-masters.dto';
import { AssetService } from '../register/asset.service';

/** Asset document types — settings-owned, assets-routed, `SETTINGS`-gated, for the
 * reasons `AssetCategoriesController` documents. */
@ApiTags('Assets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.SETTINGS)
@Controller('assets/doc-types')
export class AssetDocTypesController {
  constructor(
    private readonly docTypes: AssetDocTypesService,
    private readonly assets: AssetService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Every asset document type' })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query('companyId') companyId?: string,
  ) {
    return this.docTypes.findAll(caller, companyId);
  }

  @Post()
  @ApiOperation({ summary: 'Create an asset document type' })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateAssetDocTypeDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.docTypes.create(caller, dto, ipAddress, companyId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an asset document type' })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateAssetDocTypeDto,
    @Ip() ipAddress: string,
  ) {
    return this.docTypes.update(caller, id, dto, ipAddress);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete an asset document type',
    description: '409 once any document is filed under it.',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    await this.assets.assertDocTypeUnused(caller, id);
    await this.docTypes.remove(caller, id, ipAddress);
  }
}
