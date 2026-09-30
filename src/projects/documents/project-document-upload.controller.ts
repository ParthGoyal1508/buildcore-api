import {
  Body,
  Controller,
  Get,
  Param,
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
import { rlsContextFor } from '../../common/prisma/rls-context';
import { resolveCompanyId } from '../../settings/company-scope';
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
        remark: dto.remark,
      },
      caller.id,
    );
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
