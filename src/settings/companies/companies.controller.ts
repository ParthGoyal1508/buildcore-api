import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Delete,
  Patch,
  Post,
  Res,
  UseGuards,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Response } from 'express';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { SelfService } from '../../common/decorators/route-access.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import {
  EmployeeCodeSeriesState,
  EmployeeCodeService,
} from '../employee-code/employee-code.service';
import { CompaniesService } from './companies.service';
import { OwnCompanyGuard } from './own-company.guard';
import { CompanyResponseDto } from './dto/company-response.dto';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { NumberingService } from '../code-series/numbering.service';
import { SetNumberingDto } from '../code-series/dto/numbering.dto';
import { SetBillingRatesDto } from './dto/set-billing-rates.dto';
import { SetPunchAccuracyDto } from './dto/set-punch-accuracy.dto';
import { SetLetterheadDto } from './dto/set-letterhead.dto';
import { SetLogoDto } from './dto/set-logo.dto';
import { SetPunchEnforcementDto } from './dto/set-punch-enforcement.dto';
import { CompanyBranchesService } from './company-branches.service';
import {
  CompanyBranchDto,
  CreateCompanyBranchDto,
  UpdateCompanyBranchDto,
} from './dto/company-branch.dto';

@ApiTags('settings/companies')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, OwnCompanyGuard)
// Company administration is Super-Admin-only in practice (FR-001); COMPANY_SETTINGS
// is the permission that expresses it, and only the protected role carries it.
@RequirePermissions(Permission.COMPANY_SETTINGS)
@Controller('settings/companies')
export class CompaniesController {
  constructor(
    private readonly companiesService: CompaniesService,
    private readonly employeeCodeService: EmployeeCodeService,
    private readonly numbering: NumberingService,
    private readonly branches: CompanyBranchesService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List every company, whatever its status',
    description:
      "The Settings UI's own admin list — other modules' dropdowns read the active-only export instead (FR-005).",
  })
  @ApiOkResponse({ type: [CompanyResponseDto] })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
  ): Promise<CompanyResponseDto[]> {
    const companies = await this.companiesService.findAll();
    // A company-scoped administrator sees their own company only (2026-10-16 audit, C4).
    const visible = caller.permissions.includes(Permission.CROSS_COMPANY_ACCESS)
      ? companies
      : companies.filter((company) => company.id === caller.companyId);
    return visible.map(CompanyResponseDto.fromEntity);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch one company' })
  @ApiOkResponse({ type: CompanyResponseDto })
  async findOne(@Param('id') id: string): Promise<CompanyResponseDto> {
    return CompanyResponseDto.fromEntity(
      await this.companiesService.findOne(id),
    );
  }

  @Get(':id/code-series')
  @ApiOperation({
    summary: "Read a company's employee code series state",
    description:
      'Read-only: returns the current counter and a preview of the next code without consuming it (User Story 7).',
  })
  async codeSeries(@Param('id') id: string): Promise<EmployeeCodeSeriesState> {
    return this.employeeCodeService.getCurrentState(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a company',
    description:
      'Also seeds its default document types and its employee-code counter (FR-020, FR-023).',
  })
  @ApiOkResponse({ type: CompanyResponseDto })
  @ApiConflictResponse({ description: 'shortCode already in use (FR-004)' })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateCompanyDto,
    @Ip() ipAddress: string,
  ): Promise<CompanyResponseDto> {
    return CompanyResponseDto.fromEntity(
      await this.companiesService.create(caller, dto, ipAddress),
    );
  }

  /**
   * The company's printed letterhead — the stationery every letter renders on.
   *
   * `COMPANY_SETTINGS`, matching the other company-level settings on this controller.
   * Replacing it changes the appearance of every letter issued from now on; letters
   * already issued keep their own rendered PDF and are unaffected, which is the same
   * freeze `appliedSignatureRef` gives a signature.
   */
  @Put(':id/letterhead')
  @RequirePermissions(Permission.COMPANY_SETTINGS)
  @ApiOperation({
    summary: 'Upload the company letterhead (2026-10-11)',
    description:
      'A **full-page** image — header, blank middle, footer — as the pre-printed ' +
      'stationery is. The renderer draws it to the page edges on every page and lays ' +
      'the letter body inside the clear band.\n\n' +
      'The content type is detected from the bytes; anything that is not an image is ' +
      'refused with a 400 here, rather than silently printing every letter on plain ' +
      'paper later.',
  })
  async setLetterhead(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SetLetterheadDto,
    @Ip() ipAddress: string,
  ) {
    return this.companiesService.setLetterhead(caller, id, dto.data, ipAddress);
  }

  @Get(':id/letterhead')
  @ApiOperation({
    summary: 'The letterhead currently in force',
    description:
      'Served as the image itself so a settings screen can show what letters will be ' +
      'printed on. 404 when the company has none, which is a legitimate state — those ' +
      'companies render on plain paper.',
  })
  async getLetterhead(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { bytes, contentType } = await this.companiesService.getLetterhead(
      caller,
      id,
    );
    res.setHeader('Content-Type', contentType);
    res.status(200).send(bytes);
  }

  /**
   * The company's logo — the mark the shell shows once this company is selected.
   *
   * `COMPANY_SETTINGS`, like the letterhead above. Changing it changes what everyone
   * working in this company sees in the sidebar from their next page load.
   */
  @Put(':id/logo')
  @RequirePermissions(Permission.COMPANY_SETTINGS)
  @ApiOperation({
    summary: 'Upload the company logo (2026-10-12)',
    description:
      'Shown in the sidebar and the mobile shell header in place of the product mark, ' +
      'so switching company switches the logo. Drawn at about 32 pixels tall against ' +
      'both a white panel and a blue one.\n\n' +
      'The content type is detected from the bytes; anything that is not an image is ' +
      'refused with a 400 here rather than becoming a broken image in everybody’s ' +
      'sidebar.',
  })
  async setLogo(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SetLogoDto,
    @Ip() ipAddress: string,
  ) {
    return this.companiesService.setLogo(caller, id, dto.data, ipAddress);
  }

  /**
   * Open to every signed-in user of the company (039). The description below always said so, but
   * the class-level `COMPANY_SETTINGS` applied here too, so everyone without it — every role but
   * Super Admin — drew a 403 in the sidebar on every page. The empty `@RequirePermissions()`
   * overrides the class's list; `@SelfService()` then declares the route, and `OwnCompanyGuard`
   * still confines the caller to their own company.
   */
  @Get(':id/logo')
  @RequirePermissions()
  @SelfService()
  @ApiOperation({
    summary: 'The company logo currently in force',
    description:
      'Served as the image itself. **404 when the company has none**, which is a ' +
      'legitimate state and not an error: the interface falls back to the product mark. ' +
      'Deliberately not gated on `COMPANY_SETTINGS` — everyone working in the company ' +
      'sees this in their sidebar, and only people who may *change* it need that ' +
      'permission.',
  })
  async getLogo(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Res() res: Response,
    @Query('v') requestedVersion?: string,
  ): Promise<void> {
    const { bytes, contentType, version } = await this.companiesService.getLogo(
      caller,
      id,
    );
    res.setHeader('Content-Type', contentType);
    res.setHeader('ETag', `"logo-${version}"`);
    /**
     * Cache headers (2026-10-14 — "the company logo takes too long to load when switching
     * companies").
     *
     * A request that names the version currently in force (`?v=`, from the selectable-companies
     * list) is asking for bytes that can never change under that URL — a new upload is a new
     * version and so a new URL — so it may be kept for a year without revalidating. `private`,
     * because the image sits behind the session: a browser may keep it, a shared proxy may not.
     *
     * Anything else (no `v`, or a stale one) gets `no-cache` with the ETag: still storable, but
     * checked each time, so a client holding an outdated URL converges on the new logo with a
     * 304-sized round trip rather than a full download.
     */
    res.setHeader(
      'Cache-Control',
      requestedVersion === version
        ? 'private, max-age=31536000, immutable'
        : 'private, no-cache',
    );
    if (res.req.headers['if-none-match'] === `"logo-${version}"`) {
      res.status(304).end();
      return;
    }
    res.status(200).send(bytes);
  }

  @Put(':id/punch-accuracy')
  @RequirePermissions(Permission.COMPANY_SETTINGS)
  @ApiOperation({
    summary: 'Set the acceptable GPS accuracy for a punch (020 FR-012b)',
    description:
      'The client asked for this in these words — "configurable from the settings by super ' +
      'admin". `COMPANY_SETTINGS`, which Super Admin holds by definition.\n\n' +
      'Takes effect on the **next punch**, with no restart: the value is read per request in the ' +
      'same call that already reads the payroll lock day.\n\n' +
      "Send `null` to clear the company's decision and return it to the product default. That is " +
      "a different act from setting it to the default's current value — a cleared company follows " +
      'the default if it ever changes, and a company that chose 50 does not.',
  })
  async setPunchAccuracy(
    @Param('id') id: string,
    @Body() dto: SetPunchAccuracyDto,
  ) {
    return this.companiesService.setPunchAccuracyMaxMetres(
      id,
      dto.punchAccuracyMaxMetres ?? null,
    );
  }

  @Get(':id/numbering')
  @ApiOperation({
    summary:
      'How the company numbers projects, vendors, work orders, machines and assets',
    description:
      'Settings → Numbering (2026-10-15). Each series with its format, examples, and — for the ' +
      'counted ones — the code the next record will get.',
  })
  async getNumbering(@Param('id') id: string) {
    return this.numbering.list(id);
  }

  @Put(':id/numbering/:series')
  @ApiOperation({
    summary: 'Set one series’ format',
    description:
      'Saving a counted series restarts it, so the next code is the new start plus one gap; codes ' +
      'already in use are stepped over. Existing records keep their codes.',
  })
  async setNumbering(
    @Param('id') id: string,
    @Param('series') series: string,
    @Body() dto: SetNumberingDto,
  ) {
    return this.numbering.update(id, series, dto);
  }

  @Delete(':id/numbering/:series')
  @ApiOperation({ summary: 'Put one series back to the built-in format' })
  async resetNumbering(
    @Param('id') id: string,
    @Param('series') series: string,
  ) {
    return this.numbering.reset(id, series);
  }

  @Get(':id/billing-rates')
  @ApiOperation({
    summary:
      'The statutory rates a running-account bill is computed at (025 FR-021)',
    description:
      'CGST, SGST, IGST and TDS, as fractions — `0.09` is nine per cent. They carry correct ' +
      'statutory defaults, so nothing was wrong; there was simply no way to change them short of ' +
      'SQL, which is the no-hardcoded-values principle reaching a column rather than a literal.',
  })
  async getBillingRates(@Param('id') id: string) {
    return this.companiesService.getBillingTaxRates(id);
  }

  @Patch(':id/billing-rates')
  @ApiOperation({
    summary: 'Change one or more of those rates (025 FR-021, FR-024)',
    description:
      'Each field is optional: naming one rate leaves the other three alone.\n\n' +
      '**A rate above 1 is refused.** `0.09` is nine per cent and `9` is nine hundred — a rate ' +
      'entered as a percentage into a fraction multiplies every tax on every bill by a hundred.' +
      '\n\n' +
      '**This does not move a bill that has been issued.** Issue freezes the rates onto the ' +
      'package so a document already sent reproduces identically; this governs what is composed ' +
      'after it.\n\n' +
      'Recorded with both values, because a statutory rate is the figure most able to move money ' +
      'without anybody noticing: every bill afterwards is wrong by a consistent percentage.',
  })
  async setBillingRates(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SetBillingRatesDto,
    @Ip() ip: string,
  ) {
    return this.companiesService.setBillingTaxRates(id, dto, {
      userId: caller.id,
      ipAddress: ip,
    });
  }

  @Put(':id/punch-enforcement')
  @RequirePermissions(Permission.COMPANY_SETTINGS)
  @ApiOperation({
    summary: 'Switch the hard punch refusal on or off (020 FR-013)',
    description:
      'While this is false — the default for every company — a punch that fails location or face ' +
      'validation is recorded as an exception for an admin, exactly as today, and the would-be ' +
      'refusal is logged so the rate can be measured. While it is true the punch is refused with ' +
      '422 and **nothing is written to attendance at all**.\n\n' +
      'Switch it on for one company first. The refusal log under `GET /hr/attendance/refusals` is ' +
      'the same shape before and after, so a fortnight of measured would-be refusals is directly ' +
      'comparable with a fortnight of real ones.\n\n' +
      'Takes effect on the next punch, with no restart.',
  })
  async setPunchEnforcement(
    @Param('id') id: string,
    @Body() dto: SetPunchEnforcementDto,
  ) {
    return this.companiesService.setPunchBlockEnforced(
      id,
      dto.punchBlockEnforced,
    );
  }

  @Get(':id/branches')
  @ApiOperation({
    summary: "A company's branches — one per GST registration (041)",
    description:
      'Head office first. Every company has exactly one head office.',
  })
  @ApiOkResponse({ type: [CompanyBranchDto] })
  listBranches(@Param('id') id: string): Promise<CompanyBranchDto[]> {
    return this.branches.list(id);
  }

  @Post(':id/branches')
  @ApiOperation({
    summary: 'Add a branch (041)',
    description:
      "The GSTIN's first two digits must be the GST code of the branch's state, and its " +
      "characters 3–12 the company's PAN when one is recorded. A new branch is never the head " +
      'office; use `POST :id/branches/:branchId/head-office` for that.',
  })
  @ApiOkResponse({ type: CompanyBranchDto })
  @ApiConflictResponse({ description: 'Another branch already has this GSTIN' })
  createBranch(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreateCompanyBranchDto,
    @Ip() ip: string,
  ): Promise<CompanyBranchDto> {
    return this.branches.create(caller, id, dto, ip);
  }

  @Patch(':id/branches/:branchId')
  @ApiOperation({
    summary: 'Edit, deactivate or reactivate a branch (041)',
    description:
      'Editing the head office also updates the company’s own GSTIN / address / codes, which ' +
      'mirror it. The head office cannot be deactivated.',
  })
  @ApiOkResponse({ type: CompanyBranchDto })
  updateBranch(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Param('branchId') branchId: string,
    @Body() dto: UpdateCompanyBranchDto,
    @Ip() ip: string,
  ): Promise<CompanyBranchDto> {
    return this.branches.update(caller, id, branchId, dto, ip);
  }

  @Post(':id/branches/:branchId/head-office')
  @ApiOperation({
    summary: 'Make this branch the head office (041)',
    description:
      'One transaction: the old head office stops being one, this one becomes it, and the ' +
      'company’s own GSTIN / address / codes are copied from it. Returns every branch.',
  })
  @ApiOkResponse({ type: [CompanyBranchDto] })
  makeHeadOffice(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Param('branchId') branchId: string,
    @Ip() ip: string,
  ): Promise<CompanyBranchDto[]> {
    return this.branches.makeHeadOffice(caller, id, branchId, ip);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edit a company',
    description:
      'Companies are never hard-deleted; deactivate with `status: "inactive"` (FR-005).',
  })
  @ApiOkResponse({ type: CompanyResponseDto })
  @ApiConflictResponse({
    description: 'shortCode collides with another company',
  })
  @ApiForbiddenResponse({ description: 'Caller lacks COMPANY_SETTINGS' })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateCompanyDto,
    @Ip() ipAddress: string,
  ): Promise<CompanyResponseDto> {
    return CompanyResponseDto.fromEntity(
      await this.companiesService.update(caller, id, dto, ipAddress),
    );
  }
}
