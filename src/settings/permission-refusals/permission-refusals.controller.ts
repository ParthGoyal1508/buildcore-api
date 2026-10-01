import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsOptional, IsString } from 'class-validator';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { withRlsContext } from '../../common/prisma/rls-context';
import { ACTOR_NAME_SELECT, actorNameOf } from '../../common/actor-name';
import { rlsContextFor } from '../../common/prisma/rls-context';
import { resolveCompanyId } from '../company-scope';

/** Filters for the refusal log. */
export class RefusalQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ enum: Permission })
  @IsOptional()
  @IsIn(Object.values(Permission))
  requiredPermission?: Permission;

  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  pageSize?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;
}

/**
 * The refusal log (019 FR-003).
 *
 * Read-only, and `USER_MANAGEMENT` — the same authority that decides who holds what is the
 * authority that should see who was refused. There is deliberately no delete route: a
 * security log an administrator can prune is a security log an administrator can prune
 * selectively. Retention is the 180-day sweep in `PermissionRefusalService`.
 */
@ApiTags('Settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.USER_MANAGEMENT)
@Controller('settings/permission-refusals')
export class PermissionRefusalsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({
    summary: 'Requests refused for want of a permission or a level',
    description:
      'Each row says what was required and **what was actually held**. A row with ' +
      '`heldLevel` set is an interface that offered a control it should have hidden — a bug ' +
      'report. A row with `heldLevel: null` is somebody reaching for a module they hold ' +
      'nothing in — a security signal. Without that distinction the two are the same row.\\n\\n' +
      '`path` is the route template, never a resolved URL: a log accumulating record ids ' +
      'becomes a store of personal data nobody classified as one.',
  })
  async list(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: RefusalQueryDto,
  ) {
    const companyId = resolveCompanyId(caller, query.companyId);
    const page = Math.max(Number(query.page ?? 1), 1);
    const pageSize = Math.min(Number(query.pageSize ?? 50), 200);

    const where = {
      companyId,
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.requiredPermission
        ? { requiredPermission: query.requiredPermission }
        : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const ctx = rlsContextFor(caller);
    const [items, total] = await withRlsContext(this.prisma, ctx, (tx) =>
      Promise.all([
        tx.permissionRefusal.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        tx.permissionRefusal.count({ where }),
      ]),
    );

    // One query for the names, never one per row.
    const users = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.user.findMany({
          where: { id: { in: [...new Set(items.map((i) => i.userId))] } },
          select: ACTOR_NAME_SELECT,
        }),
    );
    const names = new Map(users.map((u) => [u.id, actorNameOf(u)]));

    return {
      items: items.map((item) => ({
        ...item,
        userName: names.get(item.userId) ?? item.userId,
      })),
      total,
      page,
      pageSize,
    };
  }
}
