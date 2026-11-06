import {
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Permission } from '@prisma/client';

import {
  GroupAccessGuard,
  GroupAccessRefusalMessage,
} from './group-access.guard';

@Controller('plain')
class PlainController {
  @Get()
  handler() {
    return null;
  }
}

@Controller('worded')
class WordedController {
  @Get()
  @GroupAccessRefusalMessage({
    code: 'SUPER_ADMIN_REQUIRED',
    message: 'Only a Super Admin can see refused punches.',
  })
  handler() {
    return null;
  }
}

function contextFor(
  controller: new () => { handler: () => null },
  permissions: Permission[],
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user: { permissions } }) }),
    getHandler: () => controller.prototype.handler,
    getClass: () => controller,
  } as unknown as ExecutionContext;
}

function refusalOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ForbiddenException);
    return (error as ForbiddenException).getResponse();
  }
  throw new Error('expected a refusal');
}

describe('GroupAccessGuard', () => {
  const guard = new GroupAccessGuard(new Reflector());

  it('admits a caller holding CROSS_COMPANY_ACCESS', () => {
    expect(
      guard.canActivate(
        contextFor(WordedController, [Permission.CROSS_COMPANY_ACCESS]),
      ),
    ).toBe(true);
  });

  it('refuses everyone else with the Group Dashboard wording by default', () => {
    expect(
      refusalOf(() =>
        guard.canActivate(contextFor(PlainController, [Permission.ATTENDANCE])),
      ),
    ).toEqual({
      code: 'GROUP_ACCESS_REQUIRED',
      message: 'The Group Dashboard is available to group administrators only.',
    });
  });

  it('uses the route’s own wording when it gives one (058)', () => {
    expect(
      refusalOf(() =>
        guard.canActivate(
          contextFor(WordedController, [Permission.ATTENDANCE]),
        ),
      ),
    ).toEqual({
      code: 'SUPER_ADMIN_REQUIRED',
      message: 'Only a Super Admin can see refused punches.',
    });
  });
});
