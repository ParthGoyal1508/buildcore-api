import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { SelfService } from '../../common/decorators/route-access.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { callerFrom } from '../caller-context';
import { EmployeeDocumentsService } from './documents/employee-documents.service';
import { EmployeesService } from './employees.service';
import { ReferenceDataService } from '../../settings/reference-data/reference-data.service';
import { SitesService } from '../../projects/sites/sites.service';

/**
 * An employee's own record and documents (2026-10-16, My Workspace).
 *
 * The same masked view and document summary HR sees on the employee's page — sensitive numbers
 * stay masked here too — resolved from the token, never from an id.
 */
@ApiTags('My Workspace')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@SelfService()
@Controller('my')
export class MyProfileController {
  constructor(
    private readonly employees: EmployeesService,
    private readonly documents: EmployeeDocumentsService,
    private readonly referenceData: ReferenceDataService,
    private readonly sites: SitesService,
  ) {}

  @Get('profile')
  @ApiOperation({ summary: "The caller's own employee record, masked" })
  async profile(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const caller = callerFrom(user, request);
    const employee = await this.employees.requireByUserId(
      caller.rls,
      caller.userId,
    );
    const profile = await this.employees.getMasked(caller, employee.id);
    // Names rather than ids: an employee cannot read the department, designation or site masters
    // to resolve them, and a profile of cuids tells them nothing.
    const nameIn = async (
      resource: 'department' | 'designation',
      id: string | null,
    ) => {
      if (!id) return null;
      const rows = await this.referenceData.findAll(resource, user);
      const match = rows.find((row) => row.id === id);
      return match ? String(match.name ?? '') : null;
    };
    const [departmentName, designationName, siteName, managerNames] =
      await Promise.all([
        nameIn('department', employee.departmentId),
        nameIn('designation', employee.designationId),
        employee.siteId
          ? this.sites
              .getSiteById(caller.rls, employee.siteId)
              .then((site) => site.name)
              .catch(() => null)
          : Promise.resolve(null),
        employee.reportingToEmployeeId
          ? this.employees.namesByIds(caller.rls, [
              employee.reportingToEmployeeId,
            ])
          : Promise.resolve(null),
      ]);
    return {
      ...profile,
      departmentName,
      designationName,
      siteName,
      reportingManagerName: employee.reportingToEmployeeId
        ? managerNames?.get(employee.reportingToEmployeeId)?.name ?? null
        : null,
    };
  }

  @Get('documents')
  @ApiOperation({
    summary:
      "The caller's documents on file, which mandatory ones are missing, and expiries",
  })
  async documentsMine(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const caller = callerFrom(user, request);
    const employee = await this.employees.requireByUserId(
      caller.rls,
      caller.userId,
    );
    return this.documents.list(caller, employee.id);
  }
}
