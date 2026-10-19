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
import { AccessLevel } from '@prisma/client';
import type { Response } from 'express';

import { AuthenticatedUser } from '../auth/authenticated-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequireLevel } from '../common/decorators/access-level.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { UserEntity } from '../common/decorators/user.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { LETTER_READ_PERMISSIONS } from './letter-permissions';
import {
  ComposeLetterDto,
  CountersignedLetterDto,
  PrefillLetterQueryDto,
  ReissueLetterDto,
} from './dto/letter.dto';
import { LettersService } from './letters.service';
import { contentDispositionFor } from '../common/storage/file-type';

/**
 * Letters (017 US3, US4, US6).
 *
 * The required permission is a property of the kind being acted on, which is knowable only after
 * the kind is loaded — a work order and a relieving letter are not the same authority — so
 * `LettersService` refuses per kind with `LETTER_KIND_FORBIDDEN`, at the level the action needs.
 *
 * The guard is the outer gate (036 B16): a caller must hold **some** letter permission at the
 * level the verb implies before the service is asked. It cannot be the only gate, for the reason
 * above.
 */
@ApiTags('Letters')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(...LETTER_READ_PERMISSIONS)
@Controller('letters')
export class LettersController {
  constructor(private readonly letters: LettersService) {}

  @Get()
  @ApiOperation({
    summary: 'Letters for a subject — where the work is (FR-019)',
    description:
      'Filter by the opaque `subjectType`/`subjectId` pair, or by employee or candidate, ' +
      'and/or by `letterKindKey`. ' +
      'The pair is never resolved into a vendor or project by this module; the module ' +
      'that owns the subject resolves it.',
  })
  async list(
    @UserEntity() caller: AuthenticatedUser,
    @Query('subjectType') subjectType?: string,
    @Query('subjectId') subjectId?: string,
    @Query('employeeId') employeeId?: string,
    @Query('candidateId') candidateId?: string,
    @Query('includeSuperseded') includeSuperseded?: string,
    // One kind across every subject (2026-10-15) — Inventory lists every purchase order.
    @Query('letterKindKey') letterKindKey?: string,
  ) {
    const views = await this.letters.listForSubject(caller, {
      subjectType,
      subjectId,
      employeeId,
      candidateId,
      letterKindKey,
      includeSuperseded: includeSuperseded === 'true',
    });
    return this.letters.withApprovals(caller, views);
  }

  // Declared before `:id/...` routes for readability; `prefill` cannot collide with them
  // anyway, since none of them is a bare `GET /letters/:id`.
  @Get('prefill')
  @ApiOperation({
    summary: 'The compose form, pre-filled from the records',
    description:
      'Every field the kind declares, with the value the employee, candidate and company ' +
      'records give it (`""` when nothing does). Never refuses for a missing value — that ' +
      'happens at compose, with `LETTER_REQUIRED_FIELD_UNRESOLVED`. Requires the kind’s ' +
      'own permission, as every letter route does.',
  })
  async prefill(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: PrefillLetterQueryDto,
  ) {
    return this.letters.prefill(caller, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Compose a letter, issuing it when nothing gates it',
    description:
      'A kind with `requiresApproval` stops composed, with its 016 chain raised — the ' +
      'response carries `status: "composed"`. Call `POST /letters/:id/issue` once the ' +
      'chain completes; before that it is refused with 016’s `APPROVAL_NOT_COMPLETE`.',
  })
  async compose(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: ComposeLetterDto,
  ) {
    const [view] = await this.letters.withApprovals(caller, [
      await this.letters.compose(caller, dto),
    ]);
    return view;
  }

  @Post(':id/issue')
  @ApiOperation({
    summary: 'Issue a composed letter',
    description:
      '`409 APPROVAL_NOT_COMPLETE` while the chain is unfinished — 016’s code, not a ' +
      'second one meaning the same thing (FR-015a).',
  })
  async issue(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReissueLetterDto,
  ) {
    return this.letters.issue(caller, id, dto.variables ?? {});
  }

  @Post(':id/reissue')
  @ApiOperation({
    summary: 'Correct an issued letter (FR-014)',
    description:
      'Supersedes rather than overwrites. Both versions stay retrievable: a letter that ' +
      'went out is a fact, and replacing the bytes behind its id would let the company ' +
      'assert it had always said something it did not.',
  })
  async reissue(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReissueLetterDto,
  ) {
    return this.letters.reissue(caller, id, dto);
  }

  @Post(':id/countersigned')
  @ApiOperation({
    summary: 'Attach the executed copy that came back (FR-017)',
    description:
      'The issued copy keeps its own file. "We sent this" and "they signed it" are ' +
      'different claims, and FR-018 renders them differently.',
  })
  async countersigned(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CountersignedLetterDto,
  ) {
    return this.letters.attachCountersigned(caller, id, {
      data: Buffer.from(dto.data, 'base64'),
      contentType: dto.contentType,
    });
  }

  @Get(':id/download')
  @ApiOperation({
    summary: 'The document, exactly as issued (FR-013)',
    description:
      'Renders the signature that was applied at the time, not whatever the signatory’s ' +
      'graphic is today.',
  })
  async download(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const { data, view } = await this.letters.download(caller, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      contentDispositionFor(`${view.letterKindKey}-v${view.version}.pdf`),
    );
    res.send(data);
  }

  @Post('preview')
  // A POST that reads: it renders a draft and writes nothing.
  @RequireLevel(AccessLevel.read)
  @ApiOperation({
    summary: 'Preview a letter before composing it',
    description:
      'Takes the compose body and returns the PDF it would issue — marked DRAFT, with no ' +
      'reference and no signature graphic. Writes nothing. A missing required value prints as ' +
      'its label in brackets instead of being refused.',
  })
  async previewNew(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: ComposeLetterDto,
    @Res() res: Response,
  ) {
    const pdf = await this.letters.previewNew(caller, dto);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="preview.pdf"');
    res.send(pdf);
  }

  @Get(':id/preview')
  @ApiOperation({
    summary:
      'Preview a composed letter — what its approver reads before deciding',
    description:
      'Marked DRAFT. Refused once issued: download the issued document instead.',
  })
  async previewComposed(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const pdf = await this.letters.previewComposed(caller, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="preview.pdf"');
    res.send(pdf);
  }
}
