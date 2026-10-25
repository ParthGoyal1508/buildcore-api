import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { SelfService } from '../../common/decorators/route-access.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { resolveCompanyId } from '../company-scope';
import { CompanyBranchesService } from './company-branches.service';
import {
  BranchOptionDto,
  ListBranchOptionsQueryDto,
} from './dto/company-branch.dto';

/**
 * The company's branches as a picker sees them (041) — for the project, employee, letter and
 * payroll forms, whose users do not hold `COMPANY_SETTINGS`. Label, GSTIN and state only: no
 * addresses, no establishment codes. Managing branches is on `settings/companies/:id/branches`.
 */
@ApiTags('settings/companies')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('settings/company-branches')
export class CompanyBranchesController {
  constructor(private readonly branches: CompanyBranchesService) {}

  @Get()
  @SelfService()
  @ApiOperation({
    summary: "The caller's company branches, head office first",
    description:
      'Any signed-in user, for their own company; a cross-company caller names one with ' +
      '`companyId`. Inactive branches are left out unless `includeInactive=true` (filters over ' +
      'history need them).',
  })
  @ApiOkResponse({ type: [BranchOptionDto] })
  options(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListBranchOptionsQueryDto,
  ): Promise<BranchOptionDto[]> {
    return this.branches.options(
      resolveCompanyId(caller, query.companyId),
      query.includeInactive ?? false,
    );
  }
}
