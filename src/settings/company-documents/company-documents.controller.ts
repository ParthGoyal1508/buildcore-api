import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
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
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { rlsContextFor } from '../../common/prisma/rls-context';
import { resolveCompanyId } from '../company-scope';
import { CompanyDocumentsService } from './company-documents.service';
import {
  CreateCompanyDocumentKindDto,
  UploadCompanyDocumentDto,
} from './dto/company-document.dto';

/**
 * The company's statutory papers (017 US1, FR-001 to FR-006, FR-023, FR-024).
 *
 * Guarded by `COMPANY_SETTINGS` throughout: these are the documents behind the company's
 * registration numbers, and the same people who may edit those numbers are the people who
 * may see the certificates.
 *
 * There is deliberately **no delete route**. FR-006 retains superseded documents rather
 * than replacing them, so "replace" is an upload and there is nothing a delete verb would
 * honestly mean — removing a statutory paper is not an operation this feature offers.
 */
@ApiTags('Settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.COMPANY_SETTINGS)
@Controller('company-documents')
export class CompanyDocumentsController {
  constructor(private readonly documents: CompanyDocumentsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Current company documents, with the required kinds that are missing',
    description:
      'The missing list is the **server’s** answer, not something the client derives: ' +
      'the required set is configuration, and a browser computing it would be wrong the ' +
      'first time somebody changed it. Resolved in one query regardless of how many ' +
      'kinds are required (FR-003).',
  })
  async list(
    @UserEntity() caller: AuthenticatedUser,
    @Query('companyId') companyId?: string,
  ) {
    return this.documents.completenessFor(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
    );
  }

  @Get(':documentTypeId/history')
  @ApiOperation({
    summary: 'Every version of one kind, newest first',
    description:
      'The history FR-006 preserves. A renewed certificate supersedes its predecessor; ' +
      'the predecessor keeps its row and its stored file.',
  })
  async history(
    @UserEntity() caller: AuthenticatedUser,
    @Param('documentTypeId') documentTypeId: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.documents.historyFor(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      documentTypeId,
    );
  }

  @Post()
  @ApiOperation({
    summary: 'Upload a company document, superseding any current version',
    description:
      'Refuses a kind that expires when no `expiresAt` is supplied — code ' +
      '`DOCUMENT_EXPIRY_REQUIRED` (FR-004). Refused **before** the bytes are stored, so ' +
      'a rejected upload leaves nothing behind.',
  })
  async upload(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: UploadCompanyDocumentDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.documents.upload(
      rlsContextFor(caller),
      {
        companyId: resolveCompanyId(caller, companyId),
        documentTypeId: dto.documentTypeId,
        data: Buffer.from(dto.data, 'base64'),
        contentType: dto.contentType,
        documentNumber: dto.documentNumber ?? null,
        expiresAt: dto.expiresAt ?? null,
      },
      { userId: caller.id, ipAddress },
    );
  }

  @Post('types')
  @ApiOperation({
    summary: 'Define a document kind this company invents for itself (FR-001b)',
    description:
      'For anything outside the required eight — an MSME certificate, a trade licence, ' +
      'a rent agreement. Created **company-scoped**, so it appears here and never in the ' +
      'employee document list; that is what lets this route sit behind ' +
      '`COMPANY_SETTINGS` rather than the `EMPLOYEES` permission on ' +
      '`settings/document-types`. The code is derived from the name — it is an internal ' +
      'identifier, and asking for one here would be asking the wrong person.',
  })
  async createKind(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateCompanyDocumentKindDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.documents.createCompanyKind(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      dto,
      { userId: caller.id, ipAddress },
    );
  }

  @Post('required-kinds/:code')
  @ApiOperation({
    summary:
      'Bring a required document kind into existence for this company (FR-003a)',
    description:
      'For the case where a required kind is reported missing with a null document type ' +
      '— the company has never defined one, so there is nothing to upload against. Name, ' +
      'flags and restriction come from `REQUIRED_COMPANY_DOCUMENT_KINDS`; **the request ' +
      'supplies only the code**, which is what lets this sit behind `COMPANY_SETTINGS` ' +
      'while general document-type creation sits behind `EMPLOYEES`. A code outside the ' +
      'required set is refused with `DOCUMENT_KIND_NOT_REQUIRED`. Idempotent.',
  })
  async defineRequiredKind(
    @UserEntity() caller: AuthenticatedUser,
    @Param('code') code: string,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.documents.defineRequiredKind(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      code,
      { userId: caller.id, ipAddress },
    );
  }

  @Get(':id/download')
  @ApiOperation({
    summary: 'Retrieve the file',
    description:
      'Every retrieval is written to the audit log **before** the bytes are returned ' +
      '(FR-024). Written first rather than last deliberately: an entry that only appears ' +
      'once the transfer succeeded cannot describe the retrieval that failed halfway, and ' +
      'for a restricted kind the attempt is the thing worth knowing about. The entries are ' +
      'read back through feature 004’s Activity Log, not through any endpoint here.',
  })
  async download(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
    @Res() res: Response,
    @Query('companyId') companyId?: string,
  ) {
    const { data, view } = await this.documents.download(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      id,
      { userId: caller.id, ipAddress },
    );
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${view.code}-${view.id}"`,
    );
    res.send(data);
  }
}
