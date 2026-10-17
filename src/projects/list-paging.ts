import { BadRequestException } from '@nestjs/common';

/**
 * Paging for the project-scoped lists that had none (036 I26): RA bills, client bills, work
 * orders, bill packages and project documents.
 *
 * ## Backward compatible by construction
 *
 * **No `page`/`pageSize` on the request → the same bare array as before**, now capped at
 * `PROJECT_LIST_CAP` rows so one project with years of bills cannot turn a list call into an
 * unbounded read. **Either parameter present → `{ items, total, page, pageSize }`**, the shape the
 * DWR, inventory and item-master lists already answer with. The shape is chosen by the request,
 * so a caller that has not changed cannot receive the new one.
 *
 * Query strings rather than a DTO because these routes read `projectId` with `@Query('projectId')`,
 * and a `@Query()` DTO under `forbidNonWhitelisted` would refuse that very parameter.
 */
export const PROJECT_LIST_CAP = 500;
export const PROJECT_PAGE_SIZE_DEFAULT = 50;
export const PROJECT_PAGE_SIZE_MAX = 200;

export interface ListPaging {
  /** Whether the caller asked for a page, and so gets the paged shape back. */
  paged: boolean;
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

export interface Paged<T> {
  items: T[];
  /** From a separate count over the same filter — never the length of the page. */
  total: number;
  page: number;
  pageSize: number;
}

/** What every list did before 036, bar the cap: everything, newest first, as an array. */
export const UNPAGED: ListPaging = {
  paged: false,
  page: 1,
  pageSize: PROJECT_LIST_CAP,
  skip: 0,
  take: PROJECT_LIST_CAP,
};

function positiveInt(name: string, raw: string): number {
  const value = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value < 1) {
    throw new BadRequestException(
      `${name} must be a whole number of 1 or more`,
    );
  }
  return value;
}

export function listPaging(page?: string, pageSize?: string): ListPaging {
  if (page === undefined && pageSize === undefined) return UNPAGED;
  const p = page === undefined ? 1 : positiveInt('page', page);
  // Clamped rather than refused: asking for 1,000 a page is a reasonable request answered with
  // the most this list serves, not a malformed one.
  const size = Math.min(
    PROJECT_PAGE_SIZE_MAX,
    pageSize === undefined
      ? PROJECT_PAGE_SIZE_DEFAULT
      : positiveInt('pageSize', pageSize),
  );
  return {
    paged: true,
    page: p,
    pageSize: size,
    skip: (p - 1) * size,
    take: size,
  };
}

/** The rows in the shape the request asked for. `count` runs only for a paged request. */
export async function shapeList<T>(
  paging: ListPaging,
  items: T[],
  count: () => Promise<number>,
): Promise<T[] | Paged<T>> {
  if (!paging.paged) return items;
  return {
    items,
    total: await count(),
    page: paging.page,
    pageSize: paging.pageSize,
  };
}
