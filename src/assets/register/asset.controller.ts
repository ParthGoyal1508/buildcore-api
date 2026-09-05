import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Response } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { AssetSummaryService } from '../summary/asset-summary.service';
import {
  CreateAssetDto,
  ListAssetsDto,
  UpdateAssetDto,
  UploadAssetDocumentDto,
} from './dto/asset.dto';
import { AssetService } from './asset.service';

/** The asset register (spec US2), gated by `ASSETS`. */
@ApiTags('Assets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.ASSETS)
@Controller('assets')
export class AssetController {
  constructor(
    private readonly assets: AssetService,
    private readonly summary: AssetSummaryService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The asset register, filtered and paginated' })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListAssetsDto,
  ) {
    return this.assets.findAll(caller, query);
  }

  // Declared before `:id` so the literal path is not swallowed by the parameter
  // route — Nest matches in declaration order.
  @Get('summary')
  @ApiOperation({
    summary: 'Register totals grouped by category, status and project',
  })
  async getSummary(
    @UserEntity() caller: AuthenticatedUser,
    @Query('companyId') companyId?: string,
  ) {
    return this.summary.build(caller, companyId);
  }

  @Get('export')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'The register as an XLSX workbook',
    description:
      'Built and returned synchronously — see `AssetSummaryService` for why the ' +
      'spec’s async-above-a-threshold variant is not implemented yet.',
  })
  async exportRegister(
    @UserEntity() caller: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
    @Query('companyId') companyId?: string,
  ): Promise<StreamableFile> {
    const file = await this.summary.export(caller, companyId);
    response.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.filename}"`,
    );
    return new StreamableFile(file.buffer);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One asset, with its documents and per-site stock' })
  async findOne(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.assets.findOne(caller, id);
  }

  @Post()
  @ApiOperation({
    summary: 'Register an asset',
    description:
      'Allocates the next ASSETS code when none is supplied, copies the ' +
      'category’s tracking mode and depreciation policy onto the row, and opens ' +
      'its stock balance at the home site.',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateAssetDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.assets.create(caller, dto, ipAddress, companyId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an asset' })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateAssetDto,
    @Ip() ipAddress: string,
  ) {
    return this.assets.update(caller, id, dto, ipAddress);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Retire an asset from the register',
    description:
      'A soft delete (FR-031): its movement and custody history outlives it. ' +
      '409 while an allocation is open or a transfer is in flight.',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    await this.assets.remove(caller, id, ipAddress);
  }

  @Post(':id/documents')
  @ApiOperation({ summary: 'Attach a document to an asset' })
  async uploadDocument(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UploadAssetDocumentDto,
    @Ip() ipAddress: string,
  ) {
    return this.assets.uploadDocument(caller, id, dto, ipAddress);
  }

  @Get(':id/documents/:docId/download')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Download a stored document' })
  async downloadDocument(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Param('docId') docId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const file = await this.assets.downloadDocument(caller, id, docId);
    response.setHeader('Content-Type', file.contentType);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.fileName.replace(/"/g, '')}"`,
    );
    return new StreamableFile(file.buffer);
  }
}
