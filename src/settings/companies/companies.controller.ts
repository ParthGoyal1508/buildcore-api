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
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';
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
