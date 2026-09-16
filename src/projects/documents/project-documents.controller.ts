import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Post,
  Put,
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
import { SetProjectDocumentRequirementsDto } from './dto/project-document-requirement.dto';
import { ProjectDocumentsService } from './project-documents.service';
import { resolveCompanyId } from '../../settings/company-scope';

/**
 * Which documents a project is expected to hold (017 US2, FR-007, FR-008, FR-009).
 *
 * **Read and write are different authorities**, so there is no class-level permission:
 * anyone with `PROJECTS` may see what a project still owes, but changing what every
 * project owes is a `SETTINGS` decision. 016's chain configuration draws the same line
 * for the same reason.
 *
 * **This controller must be registered before `ProjectsController`.** Nest matches
 * routes in registration order, and `GET /projects/document-requirements` would
 * otherwise be swallowed by `GET /projects/:id` and answered with "project
 * document-requirements not found". `projects.module.ts` says so beside the array, and
 * the e2e proves it rather than trusting the comment.
 */
@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('projects/document-requirements')
export class ProjectDocumentsController {
  constructor(private readonly documents: ProjectDocumentsService) {}

  @Get()
  @RequirePermissions(Permission.PROJECTS)
  @ApiOperation({
    summary: 'The document kinds every project in this company must hold',
    description:
      '`usingDefaults` says whether this company has configured its own set or is ' +
      'running on the six FR-007 ships with. `undefinedCodes` names any required kind ' +
      'the company has no document type for — without it, a missing type would quietly ' +
      'shrink the required set and nobody would see the sixth kind disappear.',
  })
  async list(
    @UserEntity() caller: AuthenticatedUser,
    @Query('companyId') companyId?: string,
  ) {
    return this.documents.listRequirements(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
    );
  }

  @Put()
  @RequirePermissions(Permission.SETTINGS)
  @ApiOperation({
    summary: 'Replace the required set',
    description:
      'Replaces rather than merges — the required set is a set, and removing a kind ' +
      'has no other honest expression. Refuses a type this company does not have, code ' +
      '`PROJECT_DOCUMENT_TYPE_UNKNOWN`. Configuring requirements never blocks project ' +
      'creation (FR-009): readiness is reported, not enforced.',
  })
  async set(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: SetProjectDocumentRequirementsDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.documents.setRequirements(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      dto,
      { userId: caller.id, ipAddress },
    );
  }

  @Post('kinds/:code')
  @RequirePermissions(Permission.SETTINGS)
  @ApiOperation({
    summary: 'Bring a declared project document kind into existence (FR-007a)',
    description:
      'For a code `undefinedCodes` reports — a kind FR-007 names that this company has ' +
      'no document type for, so it cannot be required yet. Name, flags and scope come ' +
      'from `REQUIRED_PROJECT_DOCUMENT_KINDS`; the request supplies only the code. A ' +
      'code outside that set is refused with `PROJECT_DOCUMENT_KIND_NOT_REQUIRED` — the ' +
      "company's own required kinds are a different set behind a different permission. " +
      'Idempotent.',
  })
  async defineKind(
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

  /**
   * A cross-company caller must say which company they mean; everyone else is pinned to
   * their own, so a query parameter can never widen a caller's scope.
   */
}
