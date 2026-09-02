import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser } from '../../../auth/authenticated-user';
import { JwtAuthGuard } from '../../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../../common/decorators/permissions.decorator';
import { UserEntity } from '../../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { callerFrom } from '../../caller-context';
import { UploadEmployeeDocumentDto } from './dto/upload-document.dto';
import { EmployeeDocumentsService } from './employee-documents.service';

/**
 * Employee documents (005 US2).
 *
 * Nested under the employee rather than exposed as a flat `/hr/documents` so the
 * owning employee — and therefore the RLS scope — is always part of the route, and
 * a document can never be addressed without one.
 */
@ApiTags('HR — Employees')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.EMPLOYEES)
@Controller('hr/employees/:employeeId/documents')
export class EmployeeDocumentsController {
  constructor(private readonly documents: EmployeeDocumentsService) {}

  @Get()
  @ApiOperation({
    summary: "An employee's documents plus mandatory-completion progress",
    description:
      'Each document carries its expiry state (valid / expiring_soon / expired) ' +
      'and days remaining, negative once past.',
  })
  async list(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('employeeId') employeeId: string,
  ) {
    return this.documents.list(callerFrom(user, request), employeeId);
  }

  @Post()
  @ApiOperation({
    summary: 'Upload a document',
    description:
      'Re-uploading the same type replaces it — historical versions are not ' +
      'retained. Number and expiry are required when the document type says so.',
  })
  @ApiResponse({
    status: 400,
    description: 'Missing a number or expiry the document type requires.',
  })
  async upload(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('employeeId') employeeId: string,
    @Body() dto: UploadEmployeeDocumentDto,
  ) {
    return this.documents.upload(callerFrom(user, request), employeeId, dto);
  }
}
