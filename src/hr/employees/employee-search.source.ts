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

/** Employees, searchable by code and by either part of their name (021 FR-001a). */
@Injectable()
export class EmployeeSearchSource implements SearchSource, OnModuleInit {
  readonly register: SearchRegister = 'employee';
  readonly permission = Permission.EMPLOYEES;

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
      tx.employee.findMany({
        where: {
          companyId,
          OR: [
            { employeeCode: { startsWith: term, mode: 'insensitive' } },
            // `firstName` and `lastName` are matched **independently, never
            // concatenated**. Both are nullable, so a concatenation drops every employee
            // missing one of them — and in Postgres `firstName || ' ' || lastName` is
            // NULL when either side is, so the row does not merely rank badly, it
            // disappears. It is also unindexable even for the prefix case. Somebody
            // searching a surname needs the rows this would silently lose.
            { firstName: { contains: term, mode: 'insensitive' } },
            { lastName: { contains: term, mode: 'insensitive' } },
          ],
        },
        select: {
          id: true,
          employeeCode: true,
          firstName: true,
          lastName: true,
          isActive: true,
        },
        take: limit,
        orderBy: { employeeCode: 'asc' },
      }),
    );

    return rows.map((row) => ({
      register: this.register,
      id: row.id,
      code: row.employeeCode,
      label: fullName(row.firstName, row.lastName, row.employeeCode),
      // Whether they still work here. An exited employee stays findable — you search for
      // a record precisely when you need to look something up about somebody who has
      // gone — but the reader should not have to open it to learn that.
      sublabel: row.isActive ? 'Active' : 'Inactive',
      matchedOn: matchedOn(row.employeeCode, term),
      href: `/hr/employees/${row.id}`,
    }));
  }
}

/**
 * A readable name from two nullable parts.
 *
 * Falls back to the code rather than to an empty string: a result with a blank label
 * looks like a rendering fault, and the code is the one thing an employee always has.
 */
export function fullName(
  firstName: string | null,
  lastName: string | null,
  employeeCode: string,
): string {
  const joined = [firstName, lastName].filter(Boolean).join(' ').trim();
  return joined === '' ? employeeCode : joined;
}
