import { Injectable, OnModuleInit } from '@nestjs/common';
import { Permission } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import { SearchResult } from '../../search/dto/search-result.dto';
import {
  SearchRegister,
  SearchSource,
} from '../../search/search-source.interface';
import { SearchSourcesRegistry } from '../../search/search-sources.registry';

/**
 * Projects, searchable by code and by name (021 FR-001, FR-001a).
 *
 * Lives here rather than in `src/search/` because the query belongs to the module that
 * owns the table (Principle I). This class is what `src/search/` calls; it is not what
 * `src/search/` knows about.
 */
@Injectable()
export class ProjectSearchSource implements SearchSource, OnModuleInit {
  readonly register: SearchRegister = 'project';
  readonly permission = Permission.PROJECTS;

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
      tx.project.findMany({
        // `companyId` first, so every match predicate below runs inside one company's
        // rows. `@@index([companyId])` is what makes an unindexed name substring
        // tolerable at this product's scale.
        where: {
          companyId,
          OR: [
            // Prefix on code: indexable, and it is how a code is typed — nobody
            // remembers the middle of "PRJ-014".
            { code: { startsWith: term, mode: 'insensitive' } },
            // Substring on name: "Tirupati" must find "Parth Tirupati Phase II", which
            // is the whole point of the 2026-09-16 clarification. A prefix match here
            // would find neither.
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
      // The spec's edge case is two projects with the same name, distinguishable only by
      // code. The status is the cheapest fact that also tells the reader which one is
      // live.
      sublabel: row.status,
      matchedOn: matchedOn(row.code, term),
      href: `/projects/${row.id}`,
    }));
  }
}

/**
 * Which field put this row in the list (021 FR-001b, FR-003).
 *
 * Derived rather than tracked per predicate: a `findMany` with an `OR` does not report
 * which branch matched, and re-deriving it here is exact for the prefix case and costs
 * nothing. A row matching both counts as a code match, which is the stronger signal.
 */
export function matchedOn(code: string, term: string): 'code' | 'name' {
  return code.toLowerCase().startsWith(term.trim().toLowerCase())
    ? 'code'
    : 'name';
}
