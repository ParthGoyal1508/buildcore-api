import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import { Response } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { rlsContextFor } from '../../common/prisma/rls-context';
import { resolveCompanyId } from '../../settings/company-scope';
import { contentDispositionFor } from '../../common/storage/file-type';
import {
  StageProjectDocumentDto,
  UploadProjectDocumentDto,
} from './dto/project-document-upload.dto';
import { ProjectDocumentsService } from './project-documents.service';

/**
 * Filing documents against a project, and staging them before one exists (017 FR-008a, FR-009b).
 *
 * **Until this controller, nothing created a `ProjectDocument` at all.** The model was read by
 * readiness and written by nothing, so FR-008's "which documents does this project hold" had only
 * one possible answer. The gate FR-009 describes was the small part; this is the part that was
 * missing.
 *
 * `PROJECTS`, not `SETTINGS`: filing a document against a project is project work. Changing what
 * *every* project must hold is a settings decision, and lives on the other controller — FR-007c's
 * separation, and the reason a Project Manager can comply with the gate without being able to move
 * it.
 *
 * **Route order.** `POST /projects/document-uploads` is a literal segment under `/projects` and
 * must be registered before `ProjectsController`, or `GET /projects/:id` swallows it. That is the
 * third path under the trap `projects.module.ts` already documents.
 */
@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.PROJECTS)
@Controller()
export class ProjectDocumentUploadController {
  constructor(private readonly documents: ProjectDocumentsService) {}

  @Post('projects/document-uploads')
  @ApiOperation({
    summary: 'Stage a document before its project exists (FR-009b)',
    description:
      'FR-009 refuses to create a project while a mandatory kind has no document attached, so ' +
      'the documents must exist before the project does. Returns a `stagedDocumentId` to pass ' +
      'to project creation.\\n\\n' +
      '**The reference is yours alone.** Creation refuses a staged id uploaded by anybody else, ' +
      'and refuses it with the same code as a nonexistent id — so the refusal cannot be used to ' +
      'discover that another user staged something. Unused references are swept with their files ' +
      'after the staging window (FR-009d).',
  })
  async stage(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: StageProjectDocumentDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.documents.stage(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      {
        documentTypeId: dto.documentTypeId,
        documentType: dto.documentType,
        data: Buffer.from(dto.data, 'base64'),
        contentType: dto.contentType,
        fileName: dto.fileName,
        documentNumber: dto.documentNumber,
        expiresAt: dto.expiresAt,
      },
      caller.id,
    );
  }

  @Post('projects/:projectId/documents')
  @ApiOperation({
    summary: 'File a document against an existing project',
    description:
      '`documentTypeId` is optional: supplied, the document answers a required kind and counts ' +
      'toward readiness; omitted, it is filed as supplementary. Null is already what ' +
      '"supplementary" means on the column, so this adds no vocabulary.',
  })
  async upload(
    @UserEntity() caller: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Body() dto: UploadProjectDocumentDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.documents.upload(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      projectId,
      {
        documentTypeId: dto.documentTypeId,
        documentType: dto.documentType,
        data: Buffer.from(dto.data, 'base64'),
        contentType: dto.contentType,
        fileName: dto.fileName,
        remark: dto.remark,
        documentNumber: dto.documentNumber,
        expiresAt: dto.expiresAt,
      },
      caller.id,
    );
  }

  @Get('projects/:projectId/documents/:documentId/download')
  @ApiOperation({
    summary: 'Retrieve one project document’s file (FR-008a)',
    description:
      'Scoped by **project as well as id**: a mismatched pair does not resolve, so a document ' +
      'id copied from another project is a 404 rather than a download.\n\n' +
      'Unlike the company-documents equivalent this writes no audit entry, because project ' +
      'kinds carry no restriction vocabulary and there is nothing here an auditor reads the log ' +
      'for. If they ever gain one, this route gains the entry.',
  })
  async download(
    @UserEntity() caller: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Param('documentId') documentId: string,
    @Res() res: Response,
    @Query('companyId') companyId?: string,
  ) {
    const { data, filename, contentType } =
      await this.documents.downloadForProject(
        rlsContextFor(caller),
        resolveCompanyId(caller, companyId),
        projectId,
        documentId,
      );
    // The real type, not `application/octet-stream`. Serving every document as opaque bytes is
    // why a PDF opened in a text editor: the browser cannot render what it has not been told.
    res.setHeader('Content-Type', contentType);
    // Both the plain and the RFC 5987 forms — and never the raw name. A filename is typed by a
    // person, and `setHeader` throws on any byte outside latin1.
    res.setHeader('Content-Disposition', contentDispositionFor(filename));
    // For a cross-origin caller, which cannot read `Content-Disposition` off a `fetch`
    // otherwise — and the name is the only place the filename exists, since a blob URL carries
    // none of its own. `buildcore-web` reaches this through its own `/bff` rewrite and is
    // therefore same-origin, so this is not what makes it work there; it is what stops a
    // direct caller from being quietly unable to name the file.
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(data);
  }

  @Get('projects/:projectId/documents')
  @ApiOperation({
    summary: 'Every document filed against this project (FR-008a)',
    description:
      'Required and supplementary alike, **unfiltered**. Readiness is one view of a project’s ' +
      'papers and must not be the only one — filtering to the required set is exactly what made ' +
      'supplementary company documents invisible and produced this feature’s amendment D1.',
  })
  async list(
    @UserEntity() caller: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.documents.listForProject(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      projectId,
    );
  }
}
