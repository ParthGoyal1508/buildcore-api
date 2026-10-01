import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthenticatedUser } from '../auth/authenticated-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SearchConfig } from '../common/configs/config.interface';
import { UserEntity } from '../common/decorators/user.decorator';
import { rlsContextFor } from '../common/prisma/rls-context';
import { resolveCompanyId } from '../settings/company-scope';
import { SearchResponse } from './dto/search-result.dto';
import { SearchQueryDto } from './dto/search-query.dto';
import { SearchSourcesRegistry } from './search-sources.registry';

/**
 * Cross-register search (021 US1, FR-001 to FR-004) — `bugs.md` item 4.
 *
 * **Authenticated only, with no `@RequirePermissions`.** That is deliberate and is the
 * one place in this codebase where the absence is the design: a route-level guard would
 * have to name one register's permission and would then be wrong for the other three.
 * Authorisation happens per register inside `SearchSourcesRegistry`, before each source
 * is called.
 */
@ApiTags('Search')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('search')
export class SearchController {
  constructor(
    private readonly sources: SearchSourcesRegistry,
    private readonly configService: ConfigService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Find a record by its code or its name, across four registers',
    description:
      'Employees, vendors, equipment and projects, in one request. Codes match by ' +
      'prefix and names by substring, and an exact code match ranks first (FR-001b). ' +
      'A register the caller may not see contributes nothing and is not mentioned — ' +
      'indistinguishable from a register with no matches.',
  })
  async search(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: SearchQueryDto,
  ): Promise<SearchResponse> {
    const limits = this.configService.get<SearchConfig>('search');
    return this.sources.searchAll(
      caller,
      rlsContextFor(caller),
      resolveCompanyId(caller, query.companyId),
      query.q.trim(),
      {
        perRegister: limits?.perRegisterLimit ?? 10,
        total: limits?.totalLimit ?? 30,
      },
    );
  }
}
