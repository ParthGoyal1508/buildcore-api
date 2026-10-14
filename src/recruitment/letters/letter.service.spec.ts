import { BadRequestException, ConflictException } from '@nestjs/common';
import { Permission, Prisma } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { SIGNATORY_REQUIRED } from '../../letters/letter-error-codes';
import { LetterService } from './letter.service';

/**
 * Recruitment's letters go through `LettersService` (2026-10-14).
 *
 * What matters: the letter is composed by the one renderer (letterhead, reference, signature),
 * addressed to the right person, signed by somebody; the old path's values fill only the gaps
 * the records leave; and recruitment's own contract — one current letter per kind per person,
 * numbered in sequence, the raw row returned, relieving gated on F&F — survives the move.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const caller = {
  id: 'user-1',
  companyId: 'co-1',
  permissions: [Permission.RECRUITMENT, Permission.EMPLOYEES],
} as unknown as AuthenticatedUser;

const OFFER = {
  id: 'offer-1',
  companyId: 'co-1',
  candidateId: 'cand-1',
  designationId: 'des-1',
  departmentId: 'dep-1',
  offeredCtc: new Prisma.Decimal(600000),
  proposedJoiningDate: new Date('2026-11-01T00:00:00Z'),
  confirmedJoiningDate: null,
  probationMonths: 6,
  noticePeriodDays: 30,
};

function build(
  opts: {
    requiresSignature?: boolean;
    signatories?: { id: string }[];
    prefill?: { token: string; value: string }[];
    prior?: { id: string; version: number; isSuperseded: boolean }[];
    fnfProcessed?: boolean;
  } = {},
) {
  const issuedLetter = {
    findMany: jest.fn(async () => opts.prior ?? []),
    updateMany: jest.fn(async () => ({ count: 1 })),
    update: jest.fn(async ({ where, data }: any) => ({
      id: where.id,
      companyId: 'co-1',
      ...data,
    })),
  };
  const tx = {
    issuedLetter,
    candidate: { findUnique: jest.fn(async () => ({ fullName: 'Asha Rao' })) },
    resignation: { findFirst: jest.fn(async () => null) },
    $executeRaw: jest.fn(),
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  };
  const refs = {
    companyName: jest.fn(async () => 'Parth Realcon'),
    designationName: jest.fn(async () => 'Site Engineer'),
    departmentName: jest.fn(async () => 'Projects'),
    isFnfProcessed: jest.fn(async () => opts.fnfProcessed ?? true),
    getEmployee: jest.fn(async () => ({
      firstName: 'Ravi',
      lastName: 'Kumar',
      employeeCode: 'PRPL-0001',
      designationId: 'des-1',
      departmentId: null,
      dateOfJoining: new Date('2024-01-15T00:00:00Z'),
      confirmationDate: null,
    })),
  };
  const kinds = {
    requireByKey: jest.fn(async (_ctx: unknown, _co: string, key: string) => ({
      id: `kind-${key}`,
      key,
      label: `${key} letter`,
      requiresSignature: opts.requiresSignature ?? true,
    })),
  };
  const letters = {
    prefill: jest.fn(async () => ({
      letterKindKey: 'offer',
      letterKindLabel: 'Offer letter',
      fields: (opts.prefill ?? []).map((f) => ({
        ...f,
        label: f.token,
        sourceType: 'candidate',
        isRequired: true,
      })),
    })),
    compose: jest.fn(async (_caller: unknown, _dto: unknown) => ({
      id: 'letter-new',
      issuedAt: new Date(),
    })),
  };
  const signatories = {
    listFor: jest.fn(async () => opts.signatories ?? [{ id: 'sig-1' }]),
  };
  const service = new LetterService(
    prisma as any,
    { record: jest.fn() } as any,
    { get: jest.fn() } as any,
    refs as any,
    kinds as any,
    letters as any,
    signatories as any,
  );
  return { service, letters, signatories, issuedLetter, refs };
}

describe('recruitment LetterService', () => {
  it('composes the offer letter through LettersService, to the candidate, signed', async () => {
    const { service, letters } = build();
    const id = await service.generateForOffer(caller, OFFER, '');

    expect(id).toBe('letter-new');
    expect(letters.compose).toHaveBeenCalledWith(
      caller,
      expect.objectContaining({
        letterKindKey: 'offer',
        candidateId: 'cand-1',
        // The company's first active signatory, since none was named.
        signatoryId: 'sig-1',
      }),
    );
  });

  it('passes the old values only where the records leave the token blank', async () => {
    const { service, letters } = build({
      prefill: [
        // The candidate record holds these …
        { token: 'candidateName', value: 'Asha Rao (record)' },
        { token: 'postOffered', value: 'Site Engineer (record)' },
        // … and not this one.
        { token: 'joiningDate', value: '' },
        // Manual: nothing the old path knew.
        { token: 'dutyStart', value: '' },
      ],
    });
    await service.generateForOffer(caller, OFFER, '', {
      variables: { dutyStart: '9:30 AM' },
    });

    const { variables } = letters.compose.mock.calls[0][1] as any;
    expect(variables).not.toHaveProperty('candidateName');
    expect(variables).not.toHaveProperty('postOffered');
    expect(variables.joiningDate).toBe('01 Nov 2026');
    // What the caller typed is passed through and wins.
    expect(variables.dutyStart).toBe('9:30 AM');
  });

  it('uses the signatory the caller names over the default', async () => {
    const { service, letters, signatories } = build();
    await service.generateForOffer(caller, OFFER, '', { signatoryId: 'sig-9' });
    expect(letters.compose.mock.calls[0][1]).toMatchObject({
      signatoryId: 'sig-9',
    });
    expect(signatories.listFor).not.toHaveBeenCalled();
  });

  it('refuses, naming Settings → Signatories, when the company has no signatory', async () => {
    const { service, letters } = build({ signatories: [] });
    const error = await service
      .generateForOffer(caller, OFFER, '')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    const body = (error as BadRequestException).getResponse() as any;
    expect(body.code).toBe(SIGNATORY_REQUIRED);
    expect(body.message).toContain('Settings → Signatories');
    expect(letters.compose).not.toHaveBeenCalled();
  });

  it('names no signatory for a kind that carries none', async () => {
    const { service, letters, signatories } = build({
      requiresSignature: false,
    });
    await service.generateForEmployee(
      caller,
      { letterType: 'experience', employeeId: 'emp-1' },
      '',
    );
    expect(signatories.listFor).not.toHaveBeenCalled();
    expect(letters.compose.mock.calls[0][1]).toMatchObject({
      letterKindKey: 'experience',
      employeeId: 'emp-1',
      signatoryId: undefined,
    });
  });

  it('supersedes the previous letter of the kind and takes the next version', async () => {
    const { service, issuedLetter } = build({
      prior: [
        { id: 'old-1', version: 1, isSuperseded: true },
        { id: 'old-2', version: 2, isSuperseded: false },
      ],
    });
    const row = await service.generateForEmployee(
      caller,
      { letterType: 'appointment', employeeId: 'emp-1' },
      '',
    );

    expect(issuedLetter.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['old-2'] } },
      data: { isSuperseded: true },
    });
    // The raw row, as `POST recruitment/letters` has always answered.
    expect(row).toMatchObject({ id: 'letter-new', version: 3 });
  });

  it('still refuses a relieving letter before the F&F is processed', async () => {
    const { service, letters } = build({ fnfProcessed: false });
    await expect(
      service.generateForEmployee(
        caller,
        { letterType: 'relieving', employeeId: 'emp-1' },
        '',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(letters.compose).not.toHaveBeenCalled();
  });
});
