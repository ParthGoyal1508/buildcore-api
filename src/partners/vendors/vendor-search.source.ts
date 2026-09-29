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

/** Vendors, searchable by code and by trading name (021 FR-001a). */
@Injectable()
export class VendorSearchSource implements SearchSource, OnModuleInit {
  readonly register: SearchRegister = 'vendor';
  readonly permission = Permission.PARTNERS;

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
      tx.vendor.findMany({
        where: {
          companyId,
          OR: [
            { code: { startsWith: term, mode: 'insensitive' } },
            { name: { contains: term, mode: 'insensitive' } },
          ],
        },
        select: { id: true, code: true, name: true },
        take: limit,
        orderBy: { code: 'asc' },
      }),
    );

    return rows.map((row) => ({
      register: this.register,
      id: row.id,
      code: row.code,
      label: row.name,
      // `Vendor` carries no status, so there is no second fact to offer. Null rather than
      // an invented one — a sublabel that says nothing is worse than none, because the
      // reader spends attention on it.
      sublabel: null,
      matchedOn: matchedOn(row.code, term),
      href: `/partners/vendors/${row.id}`,
    }));
  }
}
