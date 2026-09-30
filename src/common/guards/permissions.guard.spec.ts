import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessLevel, Permission } from '@prisma/client';

import { AuthenticatedUser, Grant } from '../../auth/authenticated-user';
import { levelForMethod } from '../access-levels';
import { ACCESS_LEVEL_KEY } from '../decorators/access-level.decorator';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import {
  PUBLIC_KEY,
  SELF_SERVICE_KEY,
} from '../decorators/route-access.decorator';
import { PermissionsGuard } from './permissions.guard';

/**
 * The level check (019 T022, T023, T024).
 *
 * The context and reflector are hand-built rather than mocked — this repository has no
 * `jest.mock` anywhere — so what is asserted is the guard's real decision given a real
 * `AuthenticatedUser` shape.
 */

const grant = (permission: Permission, level: AccessLevel): Grant => ({
  permission,
  level,
});

function contextFor(
  method: string,
  required: Permission[] | undefined,
  user: Partial<AuthenticatedUser> | undefined,
  overrideLevel?: AccessLevel,
  declared?: { selfService?: boolean; publicRoute?: boolean },
): { guard: PermissionsGuard; context: ExecutionContext } {
  const reflector = {
    getAllAndOverride: (key: string) => {
      if (key === PERMISSIONS_KEY) return required;
      if (key === ACCESS_LEVEL_KEY) return overrideLevel;
      if (key === SELF_SERVICE_KEY) return declared?.selfService;
      if (key === PUBLIC_KEY) return declared?.publicRoute;
      return undefined;
    },
  } as unknown as Reflector;

  const context = {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user, method }) }),
  } as unknown as ExecutionContext;

  return { guard: new PermissionsGuard(reflector), context };
}

describe('levelForMethod', () => {
  it('maps read verbs to read and write verbs to write', () => {
    expect(levelForMethod('GET')).toBe(AccessLevel.read);
    expect(levelForMethod('head')).toBe(AccessLevel.read);
    expect(levelForMethod('POST')).toBe(AccessLevel.write);
    expect(levelForMethod('PATCH')).toBe(AccessLevel.write);
    expect(levelForMethod('DELETE')).toBe(AccessLevel.write);
  });

  it('defaults an unknown verb to write, not read', () => {
    // Defaulting to read would be a way past every level check the moment somebody wired
    // up a custom method. Refusing is a bug report; admitting is a hole.
    expect(levelForMethod('PURGE')).toBe(AccessLevel.write);
  });
});

describe('PermissionsGuard — levels', () => {
  const readOnly: Partial<AuthenticatedUser> = {
    permissions: [Permission.MACHINERY],
    grants: [grant(Permission.MACHINERY, AccessLevel.read)],
  };

  it('admits a GET for a role holding the area at read', () => {
    const { guard, context } = contextFor(
      'GET',
      [Permission.MACHINERY],
      readOnly,
    );
    expect(guard.canActivate(context)).toBe(true);
  });

  it('refuses a POST for that same role, with PERMISSION_LEVEL_INSUFFICIENT', () => {
    const { guard, context } = contextFor(
      'POST',
      [Permission.MACHINERY],
      readOnly,
    );
    try {
      guard.canActivate(context);
      throw new Error('expected a ForbiddenException');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenException);
      const body = (error as ForbiddenException).getResponse() as {
        code: string;
        required: { level: AccessLevel };
      };
      expect(body.code).toBe('PERMISSION_LEVEL_INSUFFICIENT');
      expect(body.required.level).toBe(AccessLevel.write);
    }
  });

  it('refuses with PERMISSION_AREA_DENIED when the area is not held at all', () => {
    // The two codes must not be interchangeable. One says the interface offered a control
    // it should have hidden; the other is somebody reaching for a module they hold
    // nothing in. A single opaque 403 makes a bug report and an intrusion look identical.
    const { guard, context } = contextFor(
      'GET',
      [Permission.PAYROLL],
      readOnly,
    );
    try {
      guard.canActivate(context);
      throw new Error('expected a ForbiddenException');
    } catch (error) {
      const body = (error as ForbiddenException).getResponse() as {
        code: string;
      };
      expect(body.code).toBe('PERMISSION_AREA_DENIED');
    }
  });

  it('admits a write for a role holding the area at write', () => {
    const { guard, context } = contextFor('PATCH', [Permission.MACHINERY], {
      permissions: [Permission.MACHINERY],
      grants: [
        grant(Permission.MACHINERY, AccessLevel.read),
        grant(Permission.MACHINERY, AccessLevel.write),
      ],
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('preserves OR semantics across areas', () => {
    // A route requiring (A, B) admits a caller holding only B at the right level, exactly
    // as before this change.
    const { guard, context } = contextFor(
      'GET',
      [Permission.PAYROLL, Permission.MACHINERY],
      readOnly,
    );
    expect(guard.canActivate(context)).toBe(true);
  });

  it('honours @RequireLevel(read) on a write verb', () => {
    // The POST-shaped read: a search or export whose filter will not fit in a query
    // string. Without the override a read-only role would be refused a legitimate read.
    const { guard, context } = contextFor(
      'POST',
      [Permission.MACHINERY],
      readOnly,
      AccessLevel.read,
    );
    expect(guard.canActivate(context)).toBe(true);
  });

  it('refuses a route that declares nothing at all (Phase 3, FR-005)', () => {
    // Changed by Phase 3, exactly as the Phase 2 version of this test said it would be.
    // Before: no decorator meant "authenticated only", which was right for the `/my/*`
    // surfaces and indistinguishable from an oversight everywhere else. Now the correct
    // cases say so and the rest fail closed — so a controller added next year is protected
    // because the guard defaults to refusing, not because somebody remembered.
    const { guard, context } = contextFor('POST', undefined, readOnly);
    try {
      guard.canActivate(context);
      throw new Error('expected a ForbiddenException');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(
        ((error as ForbiddenException).getResponse() as { code: string }).code,
      ).toBe('ROUTE_ACCESS_UNDECLARED');
    }
  });

  it('admits a route that declares @SelfService()', () => {
    // The `/my/*` surfaces: authorisation is "this row is yours", enforced in the service.
    // A permission would be wrong — every employee would need it, so it would grant nothing.
    const { guard, context } = contextFor(
      'POST',
      undefined,
      readOnly,
      undefined,
      {
        selfService: true,
      },
    );
    expect(guard.canActivate(context)).toBe(true);
  });

  it('admits a route that declares @PublicRoute()', () => {
    const { guard, context } = contextFor(
      'GET',
      undefined,
      undefined,
      undefined,
      {
        publicRoute: true,
      },
    );
    expect(guard.canActivate(context)).toBe(true);
  });

  it('records a refusal, and a failing recorder does not turn a 403 into a 500', () => {
    // FR-003. The caller was correctly refused either way, and the difference between those
    // two responses is the difference between a working system and an apparently broken one.
    const recorded: unknown[] = [];
    const reflector = {
      getAllAndOverride: (key: string) =>
        key === PERMISSIONS_KEY ? [Permission.MACHINERY] : undefined,
    } as unknown as Reflector;
    const guard = new PermissionsGuard(reflector, {
      record: (input: unknown) => {
        recorded.push(input);
        throw new Error('recorder is down');
      },
    } as never);
    const context = {
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({
        getRequest: () => ({
          user: { ...readOnly, id: 'u-1', companyId: 'co-1' },
          method: 'POST',
        }),
      }),
    } as unknown as ExecutionContext;

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      requiredLevel: AccessLevel.write,
      heldLevel: AccessLevel.read,
    });
  });

  it('refuses when there is no authenticated user', () => {
    const { guard, context } = contextFor(
      'GET',
      [Permission.MACHINERY],
      undefined,
    );
    expect(guard.canActivate(context)).toBe(false);
  });

  it('falls back to the area-only check for a caller with no grants', () => {
    // An account whose roles predate the backfill, or a hand-built test double. Refusing
    // instead would lock out every such caller on deploy, and the level model is additive.
    const { guard, context } = contextFor('POST', [Permission.MACHINERY], {
      permissions: [Permission.MACHINERY],
      grants: [],
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('treats the client’s Note 22 role correctly', () => {
    // LOGBOOK and FUEL at both levels, MACHINERY at read only. The operator may enter
    // readings, may see the register, and may not change it — which is the example the
    // client said could not be expressed.
    const operator: Partial<AuthenticatedUser> = {
      permissions: [Permission.LOGBOOK, Permission.FUEL, Permission.MACHINERY],
      grants: [
        grant(Permission.LOGBOOK, AccessLevel.read),
        grant(Permission.LOGBOOK, AccessLevel.write),
        grant(Permission.FUEL, AccessLevel.read),
        grant(Permission.FUEL, AccessLevel.write),
        grant(Permission.MACHINERY, AccessLevel.read),
      ],
    };

    expect(
      contextFor('POST', [Permission.LOGBOOK], operator).guard.canActivate(
        contextFor('POST', [Permission.LOGBOOK], operator).context,
      ),
    ).toBe(true);

    expect(
      contextFor('GET', [Permission.MACHINERY], operator).guard.canActivate(
        contextFor('GET', [Permission.MACHINERY], operator).context,
      ),
    ).toBe(true);

    const write = contextFor('PATCH', [Permission.MACHINERY], operator);
    expect(() => write.guard.canActivate(write.context)).toThrow(
      ForbiddenException,
    );
  });
});
