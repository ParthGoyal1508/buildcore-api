import { ForbiddenException } from '@nestjs/common';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import {
  CONFIRMATION_REQUIRED,
  PasswordConfirmationService,
} from '../../auth/password-confirmation.service';
import { CashVisibilityController } from './cash-visibility.controller';

/**
 * Cash visibility is Super Admin only and changes only behind a password confirmation
 * (2026-10-14). The interface hides the switch until the password is entered; these are the
 * checks that make the API refuse a caller who skips the interface.
 */

function build() {
  const update = jest.fn().mockResolvedValue({ hideCashTransactions: true });
  const findUnique = jest
    .fn()
    .mockResolvedValue({ hideCashTransactions: false });
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([]),
    company: { update, findUnique },
  };
  const prisma = {
    $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
  } as never;
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const confirmation = new PasswordConfirmationService({
    get: () => ({ jwtAccessSecret: 'test-secret' }),
  } as never);
  const controller = new CashVisibilityController(
    prisma,
    audit as never,
    confirmation,
  );
  return { controller, update, audit, confirmation };
}

const superAdmin = {
  id: 'sa-1',
  companyId: 'company-1',
  permissions: [Permission.CROSS_COMPANY_ACCESS, Permission.COMPANY_SETTINGS],
} as unknown as AuthenticatedUser;

const companyAdmin = {
  id: 'ca-1',
  companyId: 'company-1',
  permissions: [Permission.COMPANY_SETTINGS],
} as unknown as AuthenticatedUser;

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ForbiddenException);
    return ((err as ForbiddenException).getResponse() as { code: string }).code;
  }
  throw new Error('expected a refusal');
}

describe('CashVisibilityController', () => {
  it('changes the setting for a Super Admin holding a live confirmation, and audits it', async () => {
    const { controller, update, audit, confirmation } = build();
    const { confirmationToken } = confirmation.issue('sa-1', 'cash-visibility');

    await expect(
      controller.update(
        superAdmin,
        { hideCashTransactions: true },
        '203.0.113.7',
        confirmationToken,
      ),
    ).resolves.toEqual({ hideCashTransactions: true });
    expect(update).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: {
          event: 'cash_visibility_changed',
          hideCashTransactions: true,
          confirmedByPassword: true,
        },
        // The caller's address, not the route's path (2026-10-15).
        ipAddress: '203.0.113.7',
      }),
    );
  });

  it('refuses a Super Admin with no confirmation, and writes nothing', async () => {
    const { controller, update } = build();
    expect(
      await codeOf(
        controller.update(
          superAdmin,
          { hideCashTransactions: true },
          '203.0.113.7',
        ),
      ),
    ).toBe(CONFIRMATION_REQUIRED);
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses a confirmation minted for somebody else's account", async () => {
    const { controller, update, confirmation } = build();
    const { confirmationToken } = confirmation.issue(
      'other',
      'cash-visibility',
    );
    expect(
      await codeOf(
        controller.update(
          superAdmin,
          { hideCashTransactions: true },
          '203.0.113.7',
          confirmationToken,
        ),
      ),
    ).toBe(CONFIRMATION_REQUIRED);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a COMPANY_SETTINGS holder who is not a Super Admin — read and write alike', async () => {
    const { controller, update, confirmation } = build();
    const { confirmationToken } = confirmation.issue('ca-1', 'cash-visibility');
    expect(
      await codeOf(
        controller.update(
          companyAdmin,
          { hideCashTransactions: true },
          '203.0.113.7',
          confirmationToken,
        ),
      ),
    ).toBe('SUPER_ADMIN_ONLY');
    expect(await codeOf(controller.current(companyAdmin))).toBe(
      'SUPER_ADMIN_ONLY',
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('lets a Super Admin read the current value without a confirmation', async () => {
    const { controller } = build();
    await expect(controller.current(superAdmin)).resolves.toEqual({
      hideCashTransactions: false,
    });
  });
});
