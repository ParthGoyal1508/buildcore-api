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
import type { Response } from 'express';

import { AuthenticatedUser } from '../auth/authenticated-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UserEntity } from '../common/decorators/user.decorator';
import {
  ComposeLetterDto,
  CountersignedLetterDto,
  ReissueLetterDto,
} from './dto/letter.dto';
import { LettersService } from './letters.service';

/**
 * Letters (017 US3, US4, US6).
 *
 * **There is no `@RequirePermissions` on this controller, and that is the design.** The
 * contract calls the guard "per kind" for the same reason 016 has no `APPROVALS`
 * permission: a work order and a relieving letter are not the same authority. The
 * required permission is a property of the kind being acted on, which is knowable only
 * after the kind is loaded — so `LettersService` refuses with `LETTER_KIND_FORBIDDEN`,
 * and a class-level guard would have to be either too broad or wrong.
 */
@ApiTags('Letters')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('letters')
export class LettersController {
  constructor(private readonly letters: LettersService) {}

  @Get()
  @ApiOperation({
    summary: 'Letters for a subject — where the work is (FR-019)',
    description:
      'Filter by the opaque `subjectType`/`subjectId` pair, or by employee or candidate. ' +
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
  ) {
    return this.letters.listForSubject(caller, {
      subjectType,
      subjectId,
      employeeId,
      candidateId,
      includeSuperseded: includeSuperseded === 'true',
    });
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
    return this.letters.compose(caller, dto);
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
    return this.letters.issue(caller, id, dto.variables);
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
      `attachment; filename="${view.letterKindKey}-v${view.version}.pdf"`,
    );
    res.send(data);
  }
}
