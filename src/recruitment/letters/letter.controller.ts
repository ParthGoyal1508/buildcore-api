import {
  Body,
  Controller,
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
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { rlsContextFor } from '../../common/prisma/rls-context';
import { LetterKindsService } from '../../settings/letter-kinds/letter-kinds.service';
import { LetterTemplatesService } from '../../settings/letter-templates/letter-templates.service';
import { LetterService } from './letter.service';
import {
  CreateLetterTemplateDto,
  GenerateLetterDto,
  UpdateLetterTemplateDto,
} from './dto/letter.dto';
import { contentDispositionFor } from '../../common/storage/file-type';
import { resolveCompanyId } from '../../settings/company-scope';

@ApiTags('Recruitment')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.RECRUITMENT)
@Controller('recruitment')
export class LetterController {
  constructor(
    private readonly templates: LetterTemplatesService,
    private readonly letters: LetterService,
    // 017 §1: the wire still says `letterType` and still carries `offer`, but the enum
    // behind it is a table now, so the key has to be resolved to a row.
    private readonly kinds: LetterKindsService,
  ) {}

  // `POST letter-templates/install-standard` was deleted on 2026-10-25 (042 route cleanup):
  // nothing called it — not the web app, the seeds, nor the ops scripts. The same
  // synchronisation runs on every application start (`StandardTemplatesService`), and a new
  // company gets its templates from `CompaniesService.create`.

  @Get('letter-templates')
  // Recruitment's own templates, and Settings → Letter templates, which manages every kind's
  // (2026-10-14). Either permission — the guard passes on any one listed.
  @RequirePermissions(Permission.RECRUITMENT, Permission.SETTINGS)
  @ApiOperation({ summary: 'List letter templates' })
  listTemplates(
    @UserEntity() caller: AuthenticatedUser,
    @Query('companyId') companyId?: string,
  ) {
    return this.templates.findAll(caller, companyId);
  }

  /**
   * **Token validation is no longer done here, and removing it was a fix** (2026-10-03).
   *
   * This endpoint used to run `unknownTokens()` against `LETTER_TOKENS`, a map keyed by the five
   * letter types this product shipped with. `LetterTemplatesService.create` now checks the body
   * against the fields the kind actually **declares** (017 FR-011b), which is both stricter and
   * correct for a kind defined after the code shipped.
   *
   * Keeping both meant a field an administrator added to a *shipped* kind through
   * `PUT /letter-kinds/:id/fields/:token` was declared, offered by the editor, and then refused
   * here by a hardcoded list that could not know about it — FR-011b contradicted by a check written
   * before it existed. The newer refusal also names the remedy ("add the field to the kind") rather
   * than just the token.
   */
  @Post('letter-templates')
  // Recruitment's own templates, and Settings → Letter templates, which manages every kind's
  // (2026-10-14). Either permission — the guard passes on any one listed.
  @RequirePermissions(Permission.RECRUITMENT, Permission.SETTINGS)
  @ApiOperation({
    summary: 'Create a letter template',
    description:
      'The body is validated against the fields its letter **kind** declares, and a token the kind ' +
      'does not declare is refused with `LETTER_FIELD_NOT_DECLARED`, naming it.',
  })
  async createTemplate(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateLetterTemplateDto,
    @Ip() ip: string,
  ) {
    // `resolveCompanyId` (036 stream 3b): honours the switcher's selected company, and a
    // company-scoped caller cannot widen to another company by naming one in the body.
    const companyId = resolveCompanyId(caller, dto.companyId);
    const kind = await this.kinds.requireByKey(
      rlsContextFor(caller),
      companyId,
      dto.letterType,
    );
    const { letterType: _letterType, ...rest } = dto;
    return this.templates.create(
      caller,
      { ...rest, letterKindId: kind.id },
      ip,
    );
  }

  @Patch('letter-templates/:id')
  // Recruitment's own templates, and Settings → Letter templates, which manages every kind's
  // (2026-10-14). Either permission — the guard passes on any one listed.
  @RequirePermissions(Permission.RECRUITMENT, Permission.SETTINGS)
  @ApiOperation({
    summary: 'Edit a letter template',
    description:
      'The body and name of a template for a shipped kind with a standard template (offer, ' +
      'appointment, relieving …) cannot be changed: the wording is the same for every company ' +
      'and is restored on every start. Such an edit is refused with 409 ' +
      '`LETTER_TEMPLATE_STANDARD_LOCKED`; `isActive` and `letterheadAssetId` remain editable. ' +
      'Templates for company-defined kinds are fully editable.',
  })
  async updateTemplate(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateLetterTemplateDto,
    @Ip() ip: string,
  ) {
    return this.templates.update(caller, id, dto, ip);
  }

  @Get('letters')
  @ApiOperation({ summary: 'List generated letters with version history' })
  listLetters(
    @UserEntity() caller: AuthenticatedUser,
    @Query('companyId') companyId?: string,
    @Query('employeeId') employeeId?: string,
  ) {
    return this.letters.findAll(caller, { companyId, employeeId });
  }

  @Post('letters')
  @ApiOperation({
    summary: 'Generate an employee letter (appointment/relieving/etc.)',
  })
  generate(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: GenerateLetterDto,
    @Ip() ip: string,
  ) {
    return this.letters.generateForEmployee(caller, dto, ip);
  }

  @Get('letters/:id/download')
  @ApiOperation({ summary: 'Download a generated letter PDF' })
  async download(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ip: string,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.letters.download(caller, id, ip);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDispositionFor(filename));
    res.send(buffer);
  }
}
