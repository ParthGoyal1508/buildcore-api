import {
  BadRequestException,
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
import { LetterType, Permission } from '@prisma/client';
import type { Response } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { LetterTemplatesService } from '../../settings/letter-templates/letter-templates.service';
import { LetterService } from './letter.service';
import { unknownTokens } from './letter-tokens.util';
import {
  CreateLetterTemplateDto,
  GenerateLetterDto,
  UpdateLetterTemplateDto,
} from './dto/letter.dto';

@ApiTags('Recruitment')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.RECRUITMENT)
@Controller('recruitment')
export class LetterController {
  constructor(
    private readonly templates: LetterTemplatesService,
    private readonly letters: LetterService,
  ) {}

  @Get('letter-templates')
  @ApiOperation({ summary: 'List letter templates' })
  listTemplates(
    @UserEntity() caller: AuthenticatedUser,
    @Query('companyId') companyId?: string,
  ) {
    return this.templates.findAll(caller, companyId);
  }

  @Post('letter-templates')
  @ApiOperation({
    summary: 'Create a letter template (unknown tokens rejected)',
  })
  createTemplate(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateLetterTemplateDto,
    @Ip() ip: string,
  ) {
    this.assertTokensKnown(dto.bodyTemplate, dto.letterType);
    return this.templates.create(caller, dto, ip);
  }

  @Patch('letter-templates/:id')
  @ApiOperation({ summary: 'Edit a letter template' })
  async updateTemplate(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateLetterTemplateDto,
    @Ip() ip: string,
  ) {
    if (dto.bodyTemplate) {
      const templates = await this.templates.findAll(caller);
      const existing = templates.find((t) => t.id === id);
      if (existing)
        this.assertTokensKnown(dto.bodyTemplate, existing.letterType);
    }
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
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  private assertTokensKnown(body: string, letterType: LetterType) {
    const unknown = unknownTokens(body, letterType);
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Unknown tokens for a ${letterType} letter: ${unknown.join(', ')}`,
      );
    }
  }
}
