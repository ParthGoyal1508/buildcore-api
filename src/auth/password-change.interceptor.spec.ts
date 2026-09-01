import { CallHandler, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CredentialOrigin } from '@prisma/client';
import { of } from 'rxjs';
import {
  PASSWORD_CHANGE_REQUIRED,
  PasswordChangeInterceptor,
} from './password-change.interceptor';

/**
 * Scope correctness for the forced-change refusal (010 FR-017a).
 *
 * The cases that matter most are the ones it must *not* refuse: this runs on every
 * authenticated request, so a false positive locks a user out of the whole
 * application rather than one screen.
 */
describe('PasswordChangeInterceptor', () => {
  const contextFor = (user: unknown): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => undefined,
      getClass: () => undefined,
    }) as never;

  /** Reaching this means the request was allowed through. */
  const next: CallHandler = { handle: () => of('allowed') };

  const build = (exempt = false) =>
    new PasswordChangeInterceptor({
      getAllAndOverride: () => exempt,
    } as unknown as Reflector);

  const account = (overrides: Record<string, unknown> = {}) => ({
    id: 'u1',
    mustChangePassword: false,
    credentialOrigin: CredentialOrigin.invite,
    ...overrides,
  });

  const owesChange = account({
    mustChangePassword: true,
    credentialOrigin: CredentialOrigin.admin_direct,
  });

  it('refuses a directly-created account that has not changed its password', () => {
    expect(() =>
      build().intercept(contextFor(owesChange), next),
    ).toThrow(ForbiddenException);
  });

  it('names a machine-readable code, so clients need not read the message', () => {
    try {
      build().intercept(contextFor(owesChange), next);
      throw new Error('expected the interceptor to refuse');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: PASSWORD_CHANGE_REQUIRED,
      });
    }
  });

  it('allows the same account once its password has been changed', () => {
    // The flag is cleared in the same write as the new hash, and this reads the
    // re-read account rather than the token — so the refusal stops immediately,
    // with no re-login (FR-017b).
    const result = build().intercept(
      contextFor(
        account({
          mustChangePassword: false,
          credentialOrigin: CredentialOrigin.admin_direct,
        }),
      ),
      next,
    );
    expect(result).toBeDefined();
  });

  it('never refuses an invite-created account, flag or not', () => {
    const result = build().intercept(
      contextFor(
        account({
          mustChangePassword: true,
          credentialOrigin: CredentialOrigin.invite,
        }),
      ),
      next,
    );
    expect(result).toBeDefined();
  });

  it('never refuses an admin-reset account (FR-017a-ii)', () => {
    // Deliberately unenforced: enforcing it would lock out anyone mid-reset the
    // moment this deploys. A recorded limitation, not an oversight.
    const result = build().intercept(
      contextFor(
        account({
          mustChangePassword: true,
          credentialOrigin: CredentialOrigin.admin_reset,
        }),
      ),
      next,
    );
    expect(result).toBeDefined();
  });

  it('never refuses an account with no recorded origin (FR-017a-i)', () => {
    // Missing metadata must not lock a real user out of everything. Failing open
    // is confined to this rule — session validity and permissions still apply.
    const result = build().intercept(
      contextFor(account({ mustChangePassword: true, credentialOrigin: null })),
      next,
    );
    expect(result).toBeDefined();
  });

  it('allows an exempt route even for an account that owes a change', () => {
    const result = build(true).intercept(contextFor(owesChange), next);
    expect(result).toBeDefined();
  });

  it('allows an unauthenticated request through, having no account to judge', () => {
    const result = build().intercept(contextFor(undefined), next);
    expect(result).toBeDefined();
  });
});
