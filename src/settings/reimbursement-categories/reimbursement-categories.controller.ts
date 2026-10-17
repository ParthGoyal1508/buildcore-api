import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
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

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { clientIpOf } from '../../hr/caller-context';
import { rlsContextFor } from '../../common/prisma/rls-context';
import { resolveCompanyId } from '../company-scope';
import {
  CreateReimbursementCategoryDto,
  UpdateReimbursementCategoryDto,
} from './dto/reimbursement-category.dto';
import { ReimbursementCategoriesService } from './reimbursement-categories.service';

/**
 * Reimbursement categories master (005 FR-045).
 *
 * Same CRUD shape as 002's Department / Designation / Document Type / Shift
 * masters. There is deliberately no delete — deactivating retires a category
 * while leaving claims already filed against it readable.
 */
@ApiTags('Settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.EMPLOYEES)
@Controller('settings/reimbursement-categories')
export class ReimbursementCategoriesController {
  constructor(private readonly categories: ReimbursementCategoriesService) {}

  /** The selected company for a Super Admin who has chosen one, else the shared rule
   * (036 B3). `user.companyId ?? requested` read the **home** company first, so a Super
   * Admin who had switched company created categories in the one they had left. */
  private companyOf(user: AuthenticatedUser, requested?: string): string {
    return resolveCompanyId(user, requested);
  }

  private actorOf(user: AuthenticatedUser, request: Request) {
    return { userId: user.id, ipAddress: clientIpOf(request) };
  }

  @Get()
  @ApiOperation({ summary: 'Every category, active or not' })
  async findAll(
    @UserEntity() user: AuthenticatedUser,
    @Query('companyId') companyId?: string,
  ) {
    return this.categories.findAll(
      rlsContextFor(user),
      this.companyOf(user, companyId),
    );
  }

  @Post()
  @ApiOperation({ summary: 'Create a category' })
  @ApiResponse({ status: 409, description: 'That code already exists.' })
  async create(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Body() dto: CreateReimbursementCategoryDto,
  ) {
    return this.categories.create(
      rlsContextFor(user),
      this.companyOf(user, dto.companyId),
      dto,
      this.actorOf(user, request),
    );
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edit a category, or retire it by setting isActive false',
  })
  async update(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: UpdateReimbursementCategoryDto,
  ) {
    return this.categories.update(
      rlsContextFor(user),
      id,
      dto,
      this.actorOf(user, request),
    );
  }
}
