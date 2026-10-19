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
  EquipmentPhotoFileQueryDto,
  EquipmentRegisterQueryDto,
  ImportEquipmentDto,
  ListEquipmentDto,
  UpdateEquipmentDto,
  UploadEquipmentDocumentDto,
  UploadEquipmentPhotoDto,
} from './dto/equipment.dto';
import { EquipmentPhotosService } from './equipment-photos.service';
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
    private readonly photos: EquipmentPhotosService,
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

  // ── Photos (036 K14) ──────────────────────────────────────────────────────

  @Post(':id/photos')
  @ApiOperation({
    summary: 'Add a photo, base64-encoded (036 K14)',
    description:
      'JPEG, PNG or WebP, up to 10 MB; anything else 415. Re-encoded to at most 2048 px with a ' +
      "320 px thumbnail. The machine's first photo becomes its main one, or pass makeMain. " +
      'At most 20 per machine (409).',
  })
  async uploadPhoto(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UploadEquipmentPhotoDto,
    @Ip() ipAddress: string,
  ) {
    return this.photos.upload(caller, id, dto, ipAddress);
  }

  @Get(':id/photos/:photoId')
  // A photo is immutable — replaced only by deleting it and adding another — so its id is a
  // version, and the browser may keep it. Private: it is still a tenant's file.
  @Header('Cache-Control', 'private, max-age=31536000, immutable')
  @ApiOperation({
    summary: 'A photo, or its thumbnail with ?size=thumb (036 K14)',
  })
  async photoFile(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Param('photoId') photoId: string,
    @Query() query: EquipmentPhotoFileQueryDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const file = await this.photos.file(
      caller,
      id,
      photoId,
      query.size ?? 'full',
    );
    response.setHeader('Content-Type', file.contentType);
    response.setHeader(
      'Content-Disposition',
      contentDispositionFor(file.fileName),
    );
    return new StreamableFile(file.buffer);
  }

  @Patch(':id/photos/:photoId/main')
  @ApiOperation({ summary: "Make a photo the machine's main one (036 K14)" })
  async setMainPhoto(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Param('photoId') photoId: string,
    @Ip() ipAddress: string,
  ) {
    return this.photos.setMain(caller, id, photoId, ipAddress);
  }

  @Delete(':id/photos/:photoId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Delete a photo (036 K14). Deleting the main one promotes the newest remaining photo.',
  })
  async deletePhoto(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Param('photoId') photoId: string,
    @Ip() ipAddress: string,
  ) {
    await this.photos.remove(caller, id, photoId, ipAddress);
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
