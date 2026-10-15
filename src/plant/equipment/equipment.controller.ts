import {
  BadRequestException,
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
import { formFormatOf, sendForm } from '../../common/form-document';
import {
  CreateEquipmentDto,
  EquipmentRegisterQueryDto,
  ImportEquipmentDto,
  ListEquipmentDto,
  UpdateEquipmentDto,
  UploadEquipmentDocumentDto,
} from './dto/equipment.dto';
import { EquipmentRegisterService } from './equipment-register.service';
import { EquipmentService } from './equipment.service';
import { contentDispositionFor } from '../../common/storage/file-type';

/**
 * The asset register (006 US2), gated by `MACHINERY`.
 *
 * `MACHINERY` already existed in 002's Permission enum — it was reserved by name
 * for exactly this module — so this feature reuses it rather than inventing
 * `PLANT_ASSETS` alongside it (research.md §7).
 */
@ApiTags('Plant')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.MACHINERY)
@Controller('plant/equipment')
export class EquipmentController {
  constructor(
    private readonly equipment: EquipmentService,
    private readonly register: EquipmentRegisterService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Paginated asset register',
    description:
      'Each row carries `expiryAlert` and `alertDocumentTypes`, so the register ' +
      'answers "is any paperwork about to lapse?" without a second call (SC-001).',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListEquipmentDto,
  ) {
    return this.equipment.findAll(caller, query);
  }

  @Get('next-code')
  @ApiOperation({
    summary: 'The code a machine with this name and year would be given',
  })
  async nextCode(
    @UserEntity() caller: AuthenticatedUser,
    @Query('name') name = '',
    @Query('year') year?: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.equipment.nextCode(
      caller,
      name,
      year && /^\d{4}$/.test(year) ? Number(year) : null,
      companyId,
    );
  }

  @Get('register.:format')
  @ApiOperation({
    summary:
      'The vehicle register — "Vehicle Details (As on …)" — as PDF or Excel',
    description:
      'Every machine with its make/model, year and registration number, then RC, insurance, ' +
      'fitness, road tax, permit and pollution — each expiry (amber within 30 days, red once ' +
      'lapsed) and whether its document is on file — then the firm and the remark.',
  })
  async registerDocument(
    @UserEntity() caller: AuthenticatedUser,
    @Param('format') format: string,
    @Query() query: EquipmentRegisterQueryDto,
    @Res() res: Response,
  ) {
    const kind = formFormatOf(format);
    if (!kind) throw new BadRequestException('Format must be pdf or xlsx');
    sendForm(res, await this.register.register(caller, query, kind));
  }

  @Post('import')
  @ApiOperation({
    summary: 'Import the Equipment Master List (.xlsx)',
    description:
      'Every listed machine type becomes an equipment category under its family; a row that ' +
      'also describes an actual machine (make, registration number, operator…) registers it. ' +
      'Safe to run twice: existing categories are kept.',
  })
  async importMasterList(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: ImportEquipmentDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.register.importMasterList(
      caller,
      dto.file,
      ipAddress,
      companyId,
    );
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One machine, with its documents and service schedules',
  })
  async findOne(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.equipment.findOne(caller, id);
  }

  @Get(':id/maintenance-cost')
  @ApiOperation({
    summary:
      'Lifetime maintenance cost, split by parts, labour and service bills',
    description: 'FR-026. Only verified service bills are counted.',
  })
  async maintenanceCost(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.equipment.maintenanceCost(caller, id);
  }

  @Post()
  @ApiOperation({
    summary: 'Register a machine',
    description:
      'The code is built automatically — letters from the name, a serial, the ' +
      'manufacturing year (`JCB01/2027`), as set in Settings → Numbering. A hired machine ' +
      'must name its vendor.',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateEquipmentDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.equipment.create(caller, dto, ipAddress, companyId);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a machine',
    description:
      '`status` cannot be set to `under_maintenance` — open a maintenance job ' +
      'instead (FR-002). `code` is immutable.',
  })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateEquipmentDto,
    @Ip() ipAddress: string,
  ) {
    return this.equipment.update(caller, id, dto, ipAddress);
  }

  @Post(':id/documents')
  @ApiOperation({
    summary: 'Attach a document, base64-encoded',
    description:
      'Base64 in JSON rather than multipart, matching every other document upload ' +
      'in this codebase. The expiry window comes from the doc type, not a literal.',
  })
  async uploadDocument(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UploadEquipmentDocumentDto,
    @Ip() ipAddress: string,
  ) {
    return this.equipment.uploadDocument(caller, id, dto, ipAddress);
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
    const file = await this.equipment.downloadDocument(caller, id, docId);
    response.setHeader('Content-Type', file.contentType);
    response.setHeader(
      'Content-Disposition',
      contentDispositionFor(file.fileName),
    );
    return new StreamableFile(file.buffer);
  }

  @Delete(':id/documents/:docId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a document' })
  async deleteDocument(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Param('docId') docId: string,
    @Ip() ipAddress: string,
  ) {
    await this.equipment.deleteDocument(caller, id, docId, ipAddress);
  }
}
