import { ConflictException } from '@nestjs/common';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { LETTER_TEMPLATE_STANDARD_LOCKED } from '../../letters/letter-error-codes';
import { standardTemplateFor } from '../../letters/standard-letter-templates';
import { LetterTemplatesService } from './letter-templates.service';

/**
 * The standard wording cannot be edited (2026-10-14).
 *
 * Every start rewrites a shipped kind's standard template back to the code, so an edit to its
 * body or name would appear to save and then vanish at the next deploy. It is refused instead,
 * with a code the editor can branch on. Everything else stays editable: the active flag and the
 * letterhead of a standard template, and every template of a company-defined kind.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const caller = {
  id: 'user-1',
  companyId: 'co-1',
  permissions: [Permission.SETTINGS],
} as unknown as AuthenticatedUser;

const offer = standardTemplateFor('offer')!;

function build(kind: { key: string; label: string; companyId: string | null }) {
  const row = {
    id: 'tpl-1',
    companyId: 'co-1',
    letterKindId: 'kind-1',
    name: offer.name,
    bodyTemplate: offer.body,
    letterheadAssetId: null,
    isActive: true,
    letterKind: kind,
  };
  const tx = {
    $executeRaw: jest.fn(),
    letterKind: { findUnique: jest.fn(async () => kind) },
    letterTemplate: {
      findUnique: jest.fn(async () => row),
      updateMany: jest.fn(),
      update: jest.fn(async ({ data }: any) => ({ ...row, ...data })),
      create: jest.fn(async ({ data }: any) => ({ ...row, ...data })),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  };
  const fields = { assertTemplateFieldsDeclared: jest.fn() };
  const service = new LetterTemplatesService(
    prisma as any,
    { record: jest.fn() } as any,
    fields as any,
  );
  return { service, tx };
}

const SHIPPED_OFFER = { key: 'offer', label: 'Offer letter', companyId: null };

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ConflictException);
  return ((error as ConflictException).getResponse() as any).code;
}

describe('LetterTemplatesService — standard wording is locked', () => {
  it('refuses an edit to the body of a standard template', async () => {
    const { service, tx } = build(SHIPPED_OFFER);
    expect(
      await codeOf(
        service.update(caller, 'tpl-1', { bodyTemplate: 'Our own.' }, ''),
      ),
    ).toBe(LETTER_TEMPLATE_STANDARD_LOCKED);
    expect(tx.letterTemplate.update).not.toHaveBeenCalled();
  });

  it('refuses a rename of a standard template', async () => {
    const { service } = build(SHIPPED_OFFER);
    expect(
      await codeOf(service.update(caller, 'tpl-1', { name: 'Offer v2' }, '')),
    ).toBe(LETTER_TEMPLATE_STANDARD_LOCKED);
  });

  it('allows the active flag and letterhead, even with the unchanged wording sent along', async () => {
    const { service, tx } = build(SHIPPED_OFFER);
    await service.update(
      caller,
      'tpl-1',
      {
        name: offer.name,
        bodyTemplate: offer.body,
        isActive: false,
        letterheadAssetId: 'asset-1',
      },
      '',
    );
    expect(tx.letterTemplate.update).toHaveBeenCalled();
  });

  it('refuses creating another template for a standard kind', async () => {
    const { service, tx } = build(SHIPPED_OFFER);
    expect(
      await codeOf(
        service.create(
          caller,
          { letterKindId: 'kind-1', name: 'Offer 2', bodyTemplate: 'x' },
          '',
        ),
      ),
    ).toBe(LETTER_TEMPLATE_STANDARD_LOCKED);
    expect(tx.letterTemplate.create).not.toHaveBeenCalled();
  });

  it('leaves company-defined kinds fully editable, even one sharing a shipped key', async () => {
    const { service, tx } = build({
      key: 'offer',
      label: 'Our offer',
      companyId: 'co-1',
    });
    await service.update(caller, 'tpl-1', { bodyTemplate: 'Our own.' }, '');
    await service.create(
      caller,
      { letterKindId: 'kind-1', name: 'Ours', bodyTemplate: 'Ours.' },
      '',
    );
    expect(tx.letterTemplate.update).toHaveBeenCalled();
    expect(tx.letterTemplate.create).toHaveBeenCalled();
  });

  it('leaves shipped kinds without a standard template editable', async () => {
    const { service, tx } = build({
      key: 'confirmation',
      label: 'Confirmation letter',
      companyId: null,
    });
    await service.update(caller, 'tpl-1', { bodyTemplate: 'Confirmed.' }, '');
    expect(tx.letterTemplate.update).toHaveBeenCalled();
  });
});
