import {
  Body,
  Controller,
  Get,
  Ip,
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
import { resolveCompanyId } from '../company-scope';
import { PutTermsTemplateDto } from './dto/terms-template.dto';
import { TermsTemplatesService } from './terms-templates.service';

/**
 * The company's standard terms and conditions (2026-10-11).
 *
 * `SETTINGS`, the permission every other company-wide master in this module sits
 * behind. These clauses go onto a document a subcontractor signs, so editing them is a
 * settings act and not a project one.
 */
@ApiTags('Settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.SETTINGS)
@Controller('settings/terms')
export class TermsTemplatesController {
  constructor(private readonly terms: TermsTemplatesService) {}

  @Get()
  @ApiOperation({
    summary: 'The standard terms for every document kind',
    description:
      'Every kind is listed, whether or not this company has written its own: a kind ' +
      'absent from the list is one the screen offers no way to start from. ' +
      '`isCustomised` says which are the company’s own and which are still the set ' +
      'this product ships.',
  })
  findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query('companyId') companyId?: string,
  ) {
    return this.terms.findAll(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
    );
  }

  @Put()
  @ApiOperation({
    summary: 'Replace the standard terms for one document kind',
    description:
      '**Changes what the next document starts from, never one already raised.** A ' +
      'work order keeps the terms it was raised under in its own column, exactly as a ' +
      'bill keeps the rate it was priced at.',
  })
  upsert(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: PutTermsTemplateDto,
    @Ip() ip: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.terms.upsert(
      caller,
      resolveCompanyId(caller, companyId),
      dto.documentKind,
      dto.body,
      ip,
    );
  }
}
