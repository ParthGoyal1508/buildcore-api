import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Response } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { formFormatOf, sendForm } from '../../common/form-document';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { contentDispositionFor } from '../../common/storage/file-type';
import { ExportThrottle } from '../../common/throttle/app-throttle';
import { decodeBase64Upload } from '../../common/uploads';
import { BankGuaranteesService } from './bank-guarantees.service';
import {
  CreateBankGuaranteeDto,
  CreateBgTenderDto,
  EncashBankGuaranteeDto,
  ExportBgTendersDto,
  ExtendBankGuaranteeDto,
  ListBgTendersDto,
  ReleaseBankGuaranteeDto,
  ReopenBankGuaranteeDto,
  UpdateBankGuaranteeDto,
  UpdateBgTenderDto,
  UploadBankGuaranteeDocumentDto,
} from './dto/bank-guarantee.dto';

/**
 * The Bank Guarantees register (037, specs/037-bank-guarantees/spec.md).
 *
 * Everything sits under `projects/bank-guarantees` and is gated on `BANK_GUARANTEES` — read for
 * GET, write for the rest, as `PermissionsGuard` decides by method. Not behind the project lock:
 * a tender's guarantees are the company's instruments with a bank, not the project's measured
 * work, and a locked project still has a guarantee that must be extended or released.
 *
 * Registered before `ProjectsController`, whose `GET projects/:id` would otherwise answer
 * `GET projects/bank-guarantees` looking for a project of that id.
 */
@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.BANK_GUARANTEES)
@Controller('projects/bank-guarantees')
export class BankGuaranteesController {
  constructor(private readonly bgs: BankGuaranteesService) {}

  @Get()
  @ApiOperation({
    summary: 'The register: tenders with their EMD and PBG guarantees',
    description:
      'Ordered by Sr. No. Each guarantee carries `displayStatus` (Running, Expired, Released, ' +
      'Encashed — Expired is derived from the dates) and `daysToExpiry`.',
  })
  list(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListBgTendersDto,
  ) {
    return this.bgs.list(caller, query);
  }

  @Get('export.:format')
  @ExportThrottle()
  @ApiOperation({
    summary:
      '"<COMPANY> TENDER BG DETAILS" — the client\'s sheet, as Excel or PDF',
    description:
      "Takes the register's filters. One row per tender, EMD and PBG side by side.",
  })
  async export(
    @UserEntity() caller: AuthenticatedUser,
    @Param('format') format: string,
    @Query() query: ExportBgTendersDto,
    @Res() res: Response,
  ) {
    const kind = formFormatOf(format);
    if (kind !== 'xlsx' && kind !== 'pdf') {
      throw new BadRequestException('Format must be xlsx or pdf');
    }
    sendForm(res, await this.bgs.export(caller, query, kind));
  }

  @Post()
  @ApiOperation({
    summary: 'Enter a tender',
    description:
      'A cross-company caller may name the company with `?companyId=`.',
  })
  createTender(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateBgTenderDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.bgs.createTender(caller, dto, ipAddress, companyId);
  }

  @Get('documents/:documentId/file')
  @ApiOperation({ summary: 'Download one guarantee document' })
  async download(
    @UserEntity() caller: AuthenticatedUser,
    @Param('documentId') documentId: string,
    @Res() res: Response,
  ) {
    const { data, filename, contentType } = await this.bgs.downloadDocument(
      caller,
      documentId,
    );
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', contentDispositionFor(filename));
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Cache-Control', 'no-store');
    res.send(data);
  }

  @Delete('documents/:documentId')
  @ApiOperation({ summary: 'Remove a guarantee document' })
  removeDocument(
    @UserEntity() caller: AuthenticatedUser,
    @Param('documentId') documentId: string,
    @Ip() ipAddress: string,
  ) {
    return this.bgs.removeDocument(caller, documentId, ipAddress);
  }

  @Patch('guarantees/:id')
  @ApiOperation({
    summary: 'Edit a running guarantee',
    description:
      'Partial. Released and encashed guarantees answer 409 `BG_NOT_RUNNING` — reopen first. ' +
      'A BG number already recorded answers 409 `BG_NUMBER_TAKEN`.',
  })
  updateGuarantee(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateBankGuaranteeDto,
    @Ip() ipAddress: string,
  ) {
    return this.bgs.updateGuarantee(caller, id, dto, ipAddress);
  }

  @Delete('guarantees/:id')
  @ApiOperation({
    summary: 'Delete a guarantee entered by mistake, with its documents',
  })
  removeGuarantee(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    return this.bgs.removeGuarantee(caller, id, ipAddress);
  }

  @Post('guarantees/:id/extend')
  @ApiOperation({
    summary:
      'Extend: a later expiry date, the previous one kept in the history',
  })
  extend(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ExtendBankGuaranteeDto,
    @Ip() ipAddress: string,
  ) {
    return this.bgs.extend(caller, id, dto, ipAddress);
  }

  @Post('guarantees/:id/release')
  @ApiOperation({ summary: 'Mark released — the department returned it' })
  release(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReleaseBankGuaranteeDto,
    @Ip() ipAddress: string,
  ) {
    return this.bgs.release(caller, id, dto, ipAddress);
  }

  @Post('guarantees/:id/encash')
  @ApiOperation({ summary: 'Mark encashed — the department invoked it' })
  encash(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: EncashBankGuaranteeDto,
    @Ip() ipAddress: string,
  ) {
    return this.bgs.encash(caller, id, dto, ipAddress);
  }

  @Post('guarantees/:id/reopen')
  @ApiOperation({
    summary: 'Back to Running, for a release or encashment recorded by mistake',
  })
  reopen(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReopenBankGuaranteeDto,
    @Ip() ipAddress: string,
  ) {
    return this.bgs.reopen(caller, id, dto, ipAddress);
  }

  @Post('guarantees/:id/documents')
  @ApiOperation({
    summary: 'Attach a document (the scanned BG copy, an extension letter)',
    description:
      'PDF, image, xlsx or docx, up to 10 MB; images are stored compressed.',
  })
  uploadDocument(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UploadBankGuaranteeDocumentDto,
    @Ip() ipAddress: string,
  ) {
    return this.bgs.uploadDocument(
      caller,
      id,
      {
        title: dto.title,
        data: decodeBase64Upload(dto.data, 'The document'),
        fileName: dto.fileName,
      },
      ipAddress,
    );
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One tender with its guarantees, documents and history',
  })
  findOne(@UserEntity() caller: AuthenticatedUser, @Param('id') id: string) {
    return this.bgs.findOne(caller, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a tender' })
  updateTender(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateBgTenderDto,
    @Ip() ipAddress: string,
  ) {
    return this.bgs.updateTender(caller, id, dto, ipAddress);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a tender with no guarantees' })
  removeTender(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    return this.bgs.removeTender(caller, id, ipAddress);
  }

  @Post(':id/guarantees')
  @ApiOperation({ summary: 'Add an EMD or PBG guarantee to a tender' })
  createGuarantee(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreateBankGuaranteeDto,
    @Ip() ipAddress: string,
  ) {
    return this.bgs.createGuarantee(caller, id, dto, ipAddress);
  }
}
