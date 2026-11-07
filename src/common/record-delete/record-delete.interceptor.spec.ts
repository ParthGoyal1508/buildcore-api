import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Permission } from '@prisma/client';
import { of } from 'rxjs';

import { OwnRecords } from '../own-records/own-records.decorator';
import { EditorMayDelete } from './editor-may-delete.decorator';
import { RecordDeleteInterceptor } from './record-delete.interceptor';

class Records {
  remove() {
    return undefined;
  }
  @EditorMayDelete()
  removePhoto() {
    return undefined;
  }
}

@OwnRecords()
class Mine {
  remove() {
    return undefined;
  }
}

function contextFor(
  method: string,
  permissions: Permission[],
  target: object,
  handler: () => void,
) {
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => target,
    switchToHttp: () => ({
      getRequest: () => ({ method, user: { permissions } }),
    }),
  } as never;
}

describe('RecordDeleteInterceptor', () => {
  const interceptor = new RecordDeleteInterceptor(new Reflector());
  const next = { handle: () => of('done') };
  const records = Records.prototype;

  it('refuses a delete from anyone but a Super Admin', () => {
    expect(() =>
      interceptor.intercept(
        contextFor('DELETE', [Permission.INVENTORY], Records, records.remove),
        next,
      ),
    ).toThrow(ForbiddenException);
  });

  it('lets a Super Admin delete', () => {
    expect(() =>
      interceptor.intercept(
        contextFor(
          'DELETE',
          [Permission.CROSS_COMPANY_ACCESS],
          Records,
          records.remove,
        ),
        next,
      ),
    ).not.toThrow();
  });

  it('leaves removing a part to the editor', () => {
    expect(() =>
      interceptor.intercept(
        contextFor(
          'DELETE',
          [Permission.PROJECTS],
          Records,
          records.removePhoto,
        ),
        next,
      ),
    ).not.toThrow();
  });

  it("leaves the caller's own records to them", () => {
    expect(() =>
      interceptor.intercept(
        contextFor(
          'DELETE',
          [Permission.MY_WORKSPACE],
          Mine,
          Mine.prototype.remove,
        ),
        next,
      ),
    ).not.toThrow();
  });

  it('ignores every other method', () => {
    expect(() =>
      interceptor.intercept(
        contextFor('PATCH', [Permission.INVENTORY], Records, records.remove),
        next,
      ),
    ).not.toThrow();
  });
});
