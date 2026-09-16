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
import { CreateSignatoryDto, UpdateSignatoryDto } from './dto/signatory.dto';
import { SignatoriesService } from './signatories.service';
import { resolveCompanyId } from '../company-scope';

/**
 * Signatories (017 US4, FR-016).
 *
 * Note what this controller does **not** expose: a route that returns the signature
 * graphic. The image is applied server-side at issue and is otherwise not something a
 * client needs — handing it out would make forging a signed letter a download away.
 */
@ApiTags('Settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.SETTINGS)
@Controller('signatories')
export class SignatoriesController {
  constructor(private readonly signatories: SignatoriesService) {}

  @Get()
  @ApiOperation({ summary: 'Named signatories available to sign letters' })
  async list(
    @UserEntity() caller: AuthenticatedUser,
    @Query('includeInactive') includeInactive?: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.signatories.listFor(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      { includeInactive: includeInactive === 'true' },
    );
  }

  @Post()
  @ApiOperation({ summary: 'Add a signatory and their signature graphic' })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateSignatoryDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.signatories.create(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      dto,
      { userId: caller.id, ipAddress },
    );
  }

  @Put(':id')
  @ApiOperation({
    summary: 'Edit a signatory, optionally replacing the graphic',
    description:
      'Replacing the graphic changes what FUTURE letters carry. Letters already issued ' +
      'keep the image applied at the time (FR-013), and the old graphic is deliberately ' +
      'not deleted — those letters still have to render.',
  })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateSignatoryDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.signatories.update(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      id,
      dto,
      { userId: caller.id, ipAddress },
    );
  }
}
