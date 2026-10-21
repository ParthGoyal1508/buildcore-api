import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { SelfService } from '../decorators/route-access.decorator';
import { UserEntity } from '../decorators/user.decorator';
import { CashPolicyService, servedCompanyOf } from './cash-policy';

/**
 * Whether cash is hidden for the company the caller is working in (038) — every signed-in user may
 * ask, because every form that offers a payment mode needs to know whether "Cash" is on the list.
 * The setting itself stays Super-Admin-only (`/settings/cash-visibility`).
 */
@ApiTags('My Workspace')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@SelfService()
@Controller('my/cash-policy')
export class MyCashPolicyController {
  constructor(private readonly cash: CashPolicyService) {}

  @Get()
  @ApiOperation({
    summary: 'Whether cash transactions are hidden for the served company',
  })
  async get(
    @UserEntity() user: AuthenticatedUser,
  ): Promise<{ hidden: boolean }> {
    return { hidden: await this.cash.isHidden(servedCompanyOf(user)) };
  }
}
