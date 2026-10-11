import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Patch,
  Post,
  Res,
  UseGuards,
  Put,
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
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import {
  EmployeeCodeSeriesState,
  EmployeeCodeService,
} from '../employee-code/employee-code.service';
import { CompaniesService } from './companies.service';
import { CompanyResponseDto } from './dto/company-response.dto';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { SetBillingRatesDto } from './dto/set-billing-rates.dto';
import { SetPunchAccuracyDto } from './dto/set-punch-accuracy.dto';
import { SetLetterheadDto } from './dto/set-letterhead.dto';
import { SetPunchEnforcementDto } from './dto/set-punch-enforcement.dto';

@ApiTags('settings/companies')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
// Company administration is Super-Admin-only in practice (FR-001); COMPANY_SETTINGS
// is the permission that expresses it, and only the protected role carries it.
@RequirePermissions(Permission.COMPANY_SETTINGS)
@Controller('settings/companies')
export class CompaniesController {
  constructor(
    private readonly companiesService: CompaniesService,
    private readonly employeeCodeService: EmployeeCodeService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List every company, whatever its status',
    description:
      "The Settings UI's own admin list — other modules' dropdowns read the active-only export instead (FR-005).",
  })
  @ApiOkResponse({ type: [CompanyResponseDto] })
  async findAll(): Promise<CompanyResponseDto[]> {
    const companies = await this.companiesService.findAll();
    return companies.map(CompanyResponseDto.fromEntity);
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
