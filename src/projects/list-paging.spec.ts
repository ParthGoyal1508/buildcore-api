import { BadRequestException } from '@nestjs/common';

import {
  PROJECT_LIST_CAP,
  PROJECT_PAGE_SIZE_MAX,
  listPaging,
  shapeList,
} from './list-paging';

/** 036 I26: paging that cannot change the answer for a caller who never asked for it. */
describe('project list paging', () => {
  it('answers a request with no page params with the bare array, capped', async () => {
    const paging = listPaging();
    expect(paging).toMatchObject({
      paged: false,
      skip: 0,
      take: PROJECT_LIST_CAP,
    });
    const count = jest.fn();
    await expect(shapeList(paging, [1, 2], count)).resolves.toEqual([1, 2]);
    // No count query for the old shape — it would be a second read nobody uses.
    expect(count).not.toHaveBeenCalled();
  });

  it('answers a paged request with items, total, page and pageSize', async () => {
    const paging = listPaging('3', '20');
    expect(paging).toMatchObject({ skip: 40, take: 20 });
    await expect(shapeList(paging, ['a'], async () => 41)).resolves.toEqual({
      items: ['a'],
      total: 41,
      page: 3,
      pageSize: 20,
    });
  });

  it('pages with only one of the two params given', () => {
    expect(listPaging('2')).toMatchObject({
      paged: true,
      page: 2,
      pageSize: 50,
    });
    expect(listPaging(undefined, '10')).toMatchObject({ page: 1, take: 10 });
  });

  it('clamps an oversized page and refuses a malformed one', () => {
    expect(listPaging('1', '10000').take).toBe(PROJECT_PAGE_SIZE_MAX);
    expect(() => listPaging('0')).toThrow(BadRequestException);
    expect(() => listPaging('1.5')).toThrow(BadRequestException);
    expect(() => listPaging('1', 'abc')).toThrow(BadRequestException);
  });
});
