import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { UserEntity } from '../../common/decorators/user.decorator';
import { SelfService } from '../../common/decorators/route-access.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CompanySelectionService } from './company-selection.service';
import { SelectCompanyDto } from './dto/select-company.dto';

/**
 * The company switcher's backend (019 FR-008 to FR-013).
 *
 * `@SelfService()`: choosing which of *your own* accessible companies you are working in is a
 * property of your session, not a permission somebody grants. Every cross-company user would
 * need such a permission, so it would grant nothing — and the authorisation that matters is
 * enforced in the service, which derives the accessible set from the caller's permissions and
 * refuses anything outside it.
 */
@ApiTags('Settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@SelfService()
@Controller()
export class CompanySelectionController {
  constructor(private readonly selection: CompanySelectionService) {}

  @Get('settings/companies/selectable')
  @ApiOperation({
    summary: 'The companies this caller may work in',
    description:
      'One element for a single-company user, which is how the interface knows not to ' +
      'offer a switcher (FR-013) without a second call to ask.',
  })
  async selectable(@UserEntity() caller: AuthenticatedUser) {
    return this.selection.selectableFor(caller);
  }

  @Put('my/company-selection')
  @ApiOperation({
    summary: 'Choose the company to work in',
    description:
      'Takes effect for **subsequent** requests; it does not retroactively rescope one in ' +
      'flight. The response carries no data beyond the company list, deliberately — a ' +
      'response that re-sent every affected list would become a second source of truth for ' +
      'every screen showing one. The interface discards its cached views on success (FR-012).',
  })
  @ApiResponse({
    status: 403,
    description:
      'COMPANY_NOT_ACCESSIBLE. A 403 rather than a 404, so the response does not reveal ' +
      'which company ids exist.',
  })
  async select(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: SelectCompanyDto,
  ) {
    return this.selection.select(caller, dto.companyId);
  }
}
