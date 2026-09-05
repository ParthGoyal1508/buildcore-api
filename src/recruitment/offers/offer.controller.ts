import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import {
  AcceptOfferDto,
  CreateOfferDto,
  DeclineOfferDto,
} from './dto/offer.dto';
import { OfferService } from './offer.service';

@ApiTags('Recruitment')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.RECRUITMENT)
@Controller('recruitment')
export class OfferController {
  constructor(private readonly offers: OfferService) {}

  @Get('candidates/:id/offers')
  @ApiOperation({ summary: 'Offers for a candidate, newest first' })
  findByCandidate(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') candidateId: string,
  ) {
    return this.offers.findByCandidate(caller, candidateId);
  }

  @Post('candidates/:id/offers')
  @ApiOperation({ summary: 'Build an offer for a Selected candidate' })
  create(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') candidateId: string,
    @Body() dto: CreateOfferDto,
    @Ip() ip: string,
  ) {
    return this.offers.create(caller, candidateId, dto, ip);
  }

  @Post('offers/:id/generate')
  @ApiOperation({ summary: 'Generate the offer letter and issue the offer' })
  generate(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ip: string,
  ) {
    return this.offers.generate(caller, id, ip);
  }

  @Patch('offers/:id/accept')
  @ApiOperation({
    summary: 'Record offer acceptance (candidate → Joining Pending)',
  })
  accept(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AcceptOfferDto,
    @Ip() ip: string,
  ) {
    return this.offers.accept(caller, id, dto, ip);
  }

  @Patch('offers/:id/decline')
  @ApiOperation({ summary: 'Record offer decline' })
  decline(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DeclineOfferDto,
    @Ip() ip: string,
  ) {
    return this.offers.decline(caller, id, dto.declineReason, ip);
  }
}
