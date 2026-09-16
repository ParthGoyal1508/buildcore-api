import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Permission } from '@prisma/client';

import { LettersService } from './letters.service';

const COMPANY = 'co-1';

type Kind = {
  id: string;
  key: string;
  label: string;
  companyId: string | null;
  requiresSignature: boolean;
  requiresApproval: boolean;
  approvalActionType: string | null;
  isActive: boolean;
};

const kind = (over: Partial<Kind> = {}): Kind => ({
  id: 'k-1',
  key: 'experience',
  label: 'Experience letter',
  companyId: null,
  requiresSignature: false,
  requiresApproval: false,
  approvalActionType: null,
  isActive: true,
  ...over,
});

const WORK_ORDER = kind({
  id: 'k-wo',
  key: 'letter_work_order',
  label: 'Work order',
  requiresApproval: true,
  approvalActionType: 'letter_work_order',
});

function harness(opts: { kind?: Kind; letter?: Record<string, unknown> } = {}) {
  const k = opts.kind ?? kind();
  const letterRow = {
    id: 'l-1',
    companyId: COMPANY,
    letterKindId: k.id,
    letterKind: k,
    employeeId: null,
    candidateId: null,
    subjectType: 'vendor',
    subjectId: 'v-1',
    templateId: 'tpl-1',
    signatoryId: null,
    appliedSignatureRef: null,
    countersignedRef: null,
    countersignedAt: null,
    renderedRef: '',
    version: 1,
    isSuperseded: false,
    issuedAt: null,
    issuedBy: 'u-1',
    createdAt: new Date(),
    ...opts.letter,
  };

  const tx = {
    issuedLetter: {
      create: jest.fn(async () => letterRow),
      findFirst: jest.fn(async () => letterRow),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => ({
        ...letterRow,
        ...args.data,
      })),
    },
    letterTemplate: {
      findFirst: jest.fn(async () => ({
        id: 'tpl-1',
        companyId: COMPANY,
        bodyTemplate: 'Dear {{vendorName}}, work order for {{amount}}.',
      })),
    },
    $executeRaw: jest.fn(),
  };

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const prisma: any = {
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  const storage: any = {
    put: jest.fn(async () => 'letter/co-1/ref-1'),
    get: jest.fn(async () => Buffer.from('png')),
  };
  const audit: any = { record: jest.fn().mockResolvedValue(undefined) };
  const kinds: any = { requireByKey: jest.fn(async () => k) };
  const templates: any = {
    getActive: jest.fn(async () => ({
      id: 'tpl-1',
      bodyTemplate: 'Dear {{vendorName}}, work order for {{amount}}.',
    })),
  };
  const documentTypes: any = {
    listForCompany: jest.fn(async () => [
      { code: 'AADHAAR', isRestricted: true },
    ]),
  };
  const signatories: any = {
    requireById: jest.fn(async () => ({
      id: 's-1',
      name: 'Sunil Agarwal',
      title: 'Director',
      signatureRef: 'signature/co-1/v1',
    })),
  };
  const approvals: any = {
    submit: jest.fn().mockResolvedValue(undefined),
    assertMayTakeEffect: jest.fn().mockResolvedValue(undefined),
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const service = new LettersService(
    prisma,
    storage,
    audit,
    kinds,
    templates,
    documentTypes,
    signatories,
    approvals,
  );
  return { service, approvals, storage, tx, signatories, kinds };
}

const callerWith = (...permissions: Permission[]) =>
  ({
    id: 'u-1',
    companyId: COMPANY,
    permissions,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

const financeCaller = callerWith(Permission.PROJECT_FINANCIALS);
const hrCaller = callerWith(Permission.EMPLOYEES);

const composeWorkOrder = {
  letterKindKey: 'letter_work_order',
  subjectType: 'vendor',
  subjectId: 'v-1',
  variables: { vendorName: 'Shree', amount: '4,50,000' },
};

describe('LettersService — the 016 gate (T041, T045, FR-015a)', () => {
  it('raises the chain for a gated kind and stops, without rendering', async () => {
    const { service, approvals, storage } = harness({ kind: WORK_ORDER });

    const view = await service.compose(financeCaller, composeWorkOrder);

    expect(approvals.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'letter_work_order',
        entityType: 'letter_work_order',
        entityId: 'l-1',
      }),
    );
    // Composed, not issued — and crucially nothing was rendered. A draft PDF is a file
    // indistinguishable from the real thing, sitting in storage with no approval behind it.
    expect(view.status).toBe('composed');
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('asks 016 whether the letter may take effect before issuing it', async () => {
    const { service, approvals } = harness({ kind: WORK_ORDER });

    await service.issue(financeCaller, 'l-1', { vendorName: 'Shree' });

    expect(approvals.assertMayTakeEffect).toHaveBeenCalledWith({
      actionType: 'letter_work_order',
      entityType: 'letter_work_order',
      entityId: 'l-1',
      companyId: COMPANY,
    });
  });

  it('does NOT ask for an ungated kind', async () => {
    const { service, approvals } = harness({ kind: kind() });

    await service.issue(hrCaller, 'l-1', {});

    // FR-022's lesson from 016: refusing where no chain was ever configured would break
    // every ungated letter at once.
    expect(approvals.assertMayTakeEffect).not.toHaveBeenCalled();
    expect(approvals.submit).not.toHaveBeenCalled();
  });

  it('propagates 016’s refusal rather than translating it', async () => {
    const { service, approvals } = harness({ kind: WORK_ORDER });
    approvals.assertMayTakeEffect.mockRejectedValue(
      new ConflictException({ code: 'APPROVAL_NOT_COMPLETE' }),
    );

    const error = await service
      .issue(financeCaller, 'l-1', {})
      .catch((e: unknown) => e);

    // 016 owns the code. A second constant meaning the same thing would let a client
    // branch on the wrong one and be silently wrong.
    expect((error as { response: { code: string } }).response.code).toBe(
      'APPROVAL_NOT_COMPLETE',
    );
  });

  it('leaves the letter unissued when the chain cannot be raised at all', async () => {
    const { service, approvals } = harness({ kind: WORK_ORDER });
    approvals.submit.mockRejectedValue(new Error('no chain configured'));

    await expect(
      service.compose(financeCaller, composeWorkOrder),
    ).rejects.toThrow();

    // Unissued is the safe state: it cannot take effect without a completed chain.
    expect(approvals.assertMayTakeEffect).not.toHaveBeenCalled();
  });
});

describe('LettersService — per-kind authority (contract Part 2)', () => {
  it('refuses a caller whose permissions do not cover the kind', async () => {
    const { service } = harness({ kind: WORK_ORDER });

    const error = await service
      .compose(hrCaller, composeWorkOrder)
      .catch((e: unknown) => e);

    // Somebody who may issue an experience certificate has no business committing the
    // company to a purchase order.
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as { response: { code: string } }).response.code).toBe(
      'LETTER_KIND_FORBIDDEN',
    );
  });

  it('requires SETTINGS for a kind nobody mapped a permission for', async () => {
    const brandNew = kind({
      id: 'k-new',
      key: 'site_pass',
      companyId: COMPANY,
    });
    const { service } = harness({ kind: brandNew });

    const refused = await service
      .compose(hrCaller, { ...composeWorkOrder, letterKindKey: 'site_pass' })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ForbiddenException);

    // Fails CLOSED. The open answer would turn FR-011 into a way to route around every
    // permission in the map: define a kind, issue anything.
    const admin = callerWith(Permission.SETTINGS);
    await expect(
      service.compose(admin, {
        ...composeWorkOrder,
        letterKindKey: 'site_pass',
      }),
    ).resolves.toBeDefined();
  });
});

describe('LettersService — addressing (research §2)', () => {
  it('refuses a letter addressed both to a person and to a subject', async () => {
    const { service } = harness({ kind: kind() });

    await expect(
      service.compose(hrCaller, {
        letterKindKey: 'experience',
        employeeId: 'e-1',
        subjectType: 'vendor',
        subjectId: 'v-1',
        variables: {},
      }),
    ).rejects.toThrow(/one answer/);
  });

  it('refuses a letter addressed to nobody', async () => {
    const { service } = harness({ kind: kind() });

    await expect(
      service.compose(hrCaller, { letterKindKey: 'experience', variables: {} }),
    ).rejects.toThrow(/must address/);
  });

  it('refuses half an opaque pair', async () => {
    const { service } = harness({ kind: kind() });

    await expect(
      service.compose(hrCaller, {
        letterKindKey: 'experience',
        subjectType: 'vendor',
        variables: {},
      }),
    ).rejects.toThrow(/meaningless apart|must address/);
  });
});

describe('LettersService — the signature freeze (T054, T056, FR-013)', () => {
  const SIGNED = kind({
    id: 'k-sig',
    key: 'transfer',
    requiresSignature: true,
  });

  it('records BOTH the signatory and the graphic as applied', async () => {
    const { service, tx } = harness({
      kind: SIGNED,
      letter: { signatoryId: 's-1' },
    });

    await service.issue(hrCaller, 'l-1', {});

    // Not just `signatoryId`. Storing only the id means re-rendering uses whatever image
    // the signatory has TODAY — and a signature that silently changes is the one thing a
    // signature may never do.
    expect(tx.issuedLetter.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          appliedSignatureRef: 'signature/co-1/v1',
        }),
      }),
    );
  });

  it('renders a letter issued with the OLD graphic, after the signatory replaced it', async () => {
    // The test that catches a signatoryId-only implementation. `download` reads the
    // stored `renderedRef` — the bytes as issued — and never re-renders from the
    // signatory's current graphic.
    const { service, storage } = harness({
      kind: SIGNED,
      letter: {
        renderedRef: 'letter/co-1/as-issued',
        appliedSignatureRef: 'signature/co-1/v1',
        issuedAt: new Date('2026-01-01'),
        signatoryId: 's-1',
      },
    });

    await service.download(hrCaller, 'l-1');

    expect(storage.get).toHaveBeenCalledWith('letter/co-1/as-issued');
    // Nothing re-rendered, so the current graphic was never consulted.
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('refuses to compose a signature-bearing kind with no signatory named', async () => {
    const { service } = harness({ kind: SIGNED });

    const error = await service
      .compose(hrCaller, {
        letterKindKey: 'transfer',
        employeeId: 'e-1',
        variables: {},
      })
      .catch((e: unknown) => e);

    expect((error as { response: { code: string } }).response.code).toBe(
      'SIGNATORY_REQUIRED',
    );
  });
});

describe('LettersService — reissue (FR-014)', () => {
  it('supersedes rather than overwriting, keeping the old file', async () => {
    const { service, tx } = harness({
      kind: kind(),
      letter: {
        renderedRef: 'letter/co-1/v1',
        issuedAt: new Date('2026-01-01'),
        employeeId: 'e-1',
        subjectType: null,
        subjectId: null,
      },
    });

    await service.reissue(hrCaller, 'l-1', { variables: { name: 'Anil' } });

    // The original is marked superseded, not deleted, and a NEW row carries v2.
    expect(tx.issuedLetter.update).toHaveBeenCalledWith({
      where: { id: 'l-1' },
      data: { isSuperseded: true },
    });
    expect(tx.issuedLetter.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ version: 2 }),
      }),
    );
  });

  it('refuses to reissue something never issued', async () => {
    const { service } = harness({ kind: kind() });

    const error = await service
      .reissue(hrCaller, 'l-1', { variables: {} })
      .catch((e: unknown) => e);

    expect((error as { response: { code: string } }).response.code).toBe(
      'LETTER_NOT_ISSUED',
    );
  });
});

describe('LettersService — FR-024 on every render, not only at save', () => {
  it('refuses to render a template that references a restricted type', async () => {
    const { service, tx } = harness({ kind: kind() });
    tx.letterTemplate.findFirst = jest.fn(async () => ({
      id: 'tpl-1',
      companyId: COMPANY,
      bodyTemplate: 'Aadhaar: {{document.AADHAAR}}',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;

    const error = await service
      .issue(hrCaller, 'l-1', {})
      .catch((e: unknown) => e);

    // Checked at render as well as at save, because `isRestricted` can be switched on
    // AFTER a template was written — and a rule enforced only at save would let that
    // template keep rendering the thing that just became regulated.
    expect((error as { response: { code: string } }).response.code).toBe(
      'DOCUMENT_TYPE_RESTRICTED',
    );
  });
});
