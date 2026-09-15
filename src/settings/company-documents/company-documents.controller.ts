import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Post,
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
import { CompanyDocumentsService } from './company-documents.service';
import { UploadCompanyDocumentDto } from './dto/company-document.dto';

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
  async list(@UserEntity() caller: AuthenticatedUser) {
    return this.documents.completenessFor(
      rlsContextFor(caller),
      caller.companyId,
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
  ) {
    return this.documents.historyFor(
      rlsContextFor(caller),
      caller.companyId,
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
  ) {
    return this.documents.upload(
      rlsContextFor(caller),
      {
        companyId: caller.companyId,
        documentTypeId: dto.documentTypeId,
        data: Buffer.from(dto.data, 'base64'),
        contentType: dto.contentType,
        documentNumber: dto.documentNumber ?? null,
        expiresAt: dto.expiresAt ?? null,
      },
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
  ) {
    const { data, view } = await this.documents.download(
      rlsContextFor(caller),
      caller.companyId,
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
