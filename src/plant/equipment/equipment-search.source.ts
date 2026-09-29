import { Injectable, OnModuleInit } from '@nestjs/common';
import { Permission } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import { matchedOn } from '../../projects/portfolio/project-search.source';
import { SearchResult } from '../../search/dto/search-result.dto';
import {
  SearchRegister,
  SearchSource,
} from '../../search/search-source.interface';
import { SearchSourcesRegistry } from '../../search/search-sources.registry';

/**
 * Equipment, searchable by code and by name (021 FR-001a).
 *
 * `MACHINERY`, not `LOGBOOK` or `FUEL`: a site operator who may enter diesel readings has
 * deliberately not been given the machinery register, and search must not be the way
 * around that. This is the same distinction feature 019 is built on.
 */
@Injectable()
export class EquipmentSearchSource implements SearchSource, OnModuleInit {
  readonly register: SearchRegister = 'equipment';
  readonly permission = Permission.MACHINERY;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sources: SearchSourcesRegistry,
  ) {}

  onModuleInit(): void {
    this.sources.register(this);
  }

  async search(
    ctx: RlsContext,
    companyId: string,
    term: string,
    limit: number,
  ): Promise<SearchResult[]> {
    const rows = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.equipment.findMany({
        where: {
          companyId,
          OR: [
            { code: { startsWith: term, mode: 'insensitive' } },
            { name: { contains: term, mode: 'insensitive' } },
          ],
        },
        select: { id: true, code: true, name: true, status: true },
        take: limit,
        orderBy: { code: 'asc' },
      }),
    );

    return rows.map((row) => ({
      register: this.register,
      id: row.id,
      code: row.code,
      label: row.name,
      sublabel: row.status,
      matchedOn: matchedOn(row.code, term),
      href: `/plant/equipment/${row.id}`,
    }));
  }
}
