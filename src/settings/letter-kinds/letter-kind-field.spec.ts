import { readFileSync } from 'fs';
import { join } from 'path';

import { LetterFieldSource } from '@prisma/client';

import { LETTER_TOKENS } from '../../recruitment/letters/letter-tokens.util';
import {
  FORBIDDEN_FIELD_PATH_FRAGMENTS,
  LetterKindFieldsService,
} from './letter-kind-fields.service';

/**
 * A letter kind declares its own fields (017 FR-011b, FR-011c — tasks T138 to T141).
 *
 * **The first test here is worth more than the rest.** T135's backfill is the risk of the whole
 * change: every live template references these tokens by name, and a seed that renames or drops one
 * breaks letters already issued. So the migration's token list is parsed and compared against
 * `LETTER_TOKENS` rather than trusting two files to stay in step.
 */

const MIGRATION = join(
  __dirname,
  '..',
  '..',
  '..',
  'prisma',
  'migrations',
  '20261002230000_letter_kind_field',
  'migration.sql',
);

/** `('offer', 'candidateName', …)` → `{ offer: ['candidateName', …] }`. */
function seededTokens(): Record<string, string[]> {
  const sql = readFileSync(MIGRATION, 'utf8');
  const out: Record<string, string[]> = {};
  const row = /^\s*\('(\w+)',\s*'(\w+)',/gm;
  let match: RegExpExecArray | null;
  while ((match = row.exec(sql)) !== null) {
    const [, kind, token] = match;
    (out[kind] ??= []).push(token);
  }
  return out;
}

describe('the backfill preserves every shipped letter type (T135, T139)', () => {
  it('finds the rows it is supposed to be checking', () => {
    // A parse that matched nothing would pass every assertion below vacuously — the failure mode of
    // every test that reads a file for a pattern.
    expect(Object.keys(seededTokens()).sort()).toEqual([
      'appointment',
      'confirmation',
      'experience',
      'offer',
      'relieving',
    ]);
  });

  it('seeds exactly the tokens each shipped kind already documented', () => {
    const seeded = seededTokens();
    for (const [kind, tokens] of Object.entries(LETTER_TOKENS)) {
      // If this fails, a template that renders today will render differently — or refuse. The
      // migration is wrong, not this test.
      expect([...seeded[kind]].sort()).toEqual([...tokens].sort());
    }
  });

  it('seeds no token a shipped kind did not document', () => {
    // The other direction. An extra token offers a field in the editor that no resolver supplies,
    // which renders blank in a signed letter.
    const seeded = seededTokens();
    for (const [kind, tokens] of Object.entries(seeded)) {
      expect([...tokens].sort()).toEqual([...LETTER_TOKENS[kind]].sort());
    }
  });

  it('pairs every non-manual field with a path and every manual one without (the CHECK)', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const row =
      /^\s*\('\w+',\s*'\w+',\s*'[^']*',\s*'(\w+)',\s*(NULL|'[^']*'),/gm;
    let match: RegExpExecArray | null;
    let checked = 0;
    while ((match = row.exec(sql)) !== null) {
      const [, source, path] = match;
      checked += 1;
      if (source === 'manual') {
        // A path on a manual field would violate the migration's own CHECK and fail to apply.
        expect(path).toBe('NULL');
      } else {
        expect(path).not.toBe('NULL');
      }
    }
    expect(checked).toBeGreaterThan(30);
  });
});

describe('validating a template against its own kind (T136, T138)', () => {
  const build = (fields: { token: string }[]) => {
    const tx = {
      $executeRaw: async () => 0,
      letterKindField: {
        findMany: async () =>
          fields.map((f) => ({
            token: f.token,
            label: f.token,
            sourceType: LetterFieldSource.manual,
            sourcePath: null,
            isRequired: false,
          })),
      },
    };
    const prisma = {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    };
    return new LetterKindFieldsService(prisma as never);
  };
  const ctx = { isSuperAdmin: true } as never;

  it('saves a template using a field its kind declares', async () => {
    const service = build([{ token: 'candidateName' }]);
    await expect(
      service.assertTemplateFieldsDeclared(
        ctx,
        'kind-1',
        'Dear {{candidateName}},',
        'save',
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses a field the kind does not declare, naming it', async () => {
    // "Invalid template" sends somebody re-reading a document they have already read. The token is
    // the one thing they need.
    const service = build([{ token: 'candidateName' }]);
    await expect(
      service.assertTemplateFieldsDeclared(
        ctx,
        'kind-1',
        'Dear {{candidateName}}, your CTC is {{offeredCtc}}.',
        'save',
      ),
    ).rejects.toThrow(/offeredCtc/);
  });

  it('refuses every token for a kind that declares none', async () => {
    // The opposite of what `unknownTokens` did, and deliberately: the permissive version is what
    // shipped a broken feature. A kind with no fields and a template full of them renders a page of
    // blanks, signed.
    const service = build([]);
    await expect(
      service.assertTemplateFieldsDeclared(
        ctx,
        'kind-1',
        'Dear {{anything}},',
        'save',
      ),
    ).rejects.toThrow(/does not declare/);
  });

  it('admits a template with no fields at all', async () => {
    // A fixed-terms letter is a real thing. Refusing it would make a kind with no fields unusable
    // rather than merely limited.
    const service = build([]);
    await expect(
      service.assertTemplateFieldsDeclared(
        ctx,
        'kind-1',
        'This letter has no variables.',
        'save',
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses at render with a different message (T137)', async () => {
    // The template is already saved, so the remedy differs: somebody removed the field after the
    // template was written, and the message has to say that rather than "add the field".
    const service = build([]);
    await expect(
      service.assertTemplateFieldsDeclared(
        ctx,
        'kind-1',
        '{{salary}}',
        'render',
      ),
    ).rejects.toThrow(/no longer declares/);
  });
});

describe('a kind cannot declare its way past the PII gate (T141)', () => {
  const service = new LetterKindFieldsService({} as never);

  it.each(FORBIDDEN_FIELD_PATH_FRAGMENTS)(
    'refuses a path naming %s',
    (fragment) => {
      expect(() => service.assertPathPermitted(fragment)).toThrow(/regulated/);
    },
  );

  it('refuses a nested path containing a forbidden fragment', () => {
    // `aadhaarEncrypted` and `employee.aadhaarEncrypted` are the same disclosure.
    expect(() =>
      service.assertPathPermitted('employee.aadhaarEncrypted'),
    ).toThrow(/regulated/);
  });

  it('is case-insensitive', () => {
    expect(() => service.assertPathPermitted('Employee.AADHAAR')).toThrow();
  });

  it('permits an ordinary path', () => {
    expect(() => service.assertPathPermitted('designation.name')).not.toThrow();
  });

  it('permits a null path, which is what manual fields have', () => {
    expect(() => service.assertPathPermitted(null)).not.toThrow();
  });
});

describe('resolving a company-defined kind’s fields (T140)', () => {
  const service = new LetterKindFieldsService({} as never);

  const fields = [
    {
      token: 'employeeName',
      label: 'Employee name',
      sourceType: LetterFieldSource.employee,
      sourcePath: 'firstName',
      isRequired: true,
    },
    {
      token: 'siteName',
      label: 'Site',
      sourceType: LetterFieldSource.project,
      sourcePath: 'site.name',
      isRequired: false,
    },
    {
      token: 'basic',
      label: 'Basic',
      sourceType: LetterFieldSource.employee,
      sourcePath: 'basic',
      isRequired: false,
    },
    {
      token: 'joiningDate',
      label: 'Joining date',
      sourceType: LetterFieldSource.employee,
      sourcePath: 'dateOfJoining',
      isRequired: false,
    },
    {
      token: 'specialTerms',
      label: 'Special terms',
      sourceType: LetterFieldSource.manual,
      sourcePath: null,
      isRequired: false,
    },
  ];

  it('reads each field from the record its kind names — the end-to-end claim item 18 made', () => {
    const values = service.resolve(
      fields,
      {
        employee: {
          firstName: 'Asha',
          basic: { toNumber: () => 45000 },
          dateOfJoining: new Date('2023-06-19T00:00:00.000Z'),
        },
        project: { site: { name: 'Ring Road Phase 2' } },
      },
      { specialTerms: 'Transport provided' },
    );

    expect(values).toEqual({
      employeeName: 'Asha',
      siteName: 'Ring Road Phase 2',
      // Indian-formatted, not "45000" in the middle of a sentence.
      basic: '45,000',
      // `DD Mon YYYY`, not an ISO timestamp.
      joiningDate: '19 Jun 2023',
      specialTerms: 'Transport provided',
    });
  });

  it('renders an unresolvable optional field as empty', () => {
    const values = service.resolve(
      fields,
      { employee: { firstName: 'Asha' } },
      {},
    );
    expect(values.siteName).toBe('');
  });

  it('refuses when a required field has no value', () => {
    // The whole point of `isRequired`: an unresolvable required field is a letter nobody should sign,
    // and a blank is indistinguishable from a deliberate omission.
    expect(() => service.resolve(fields, {}, {})).toThrow(/employeeName/);
  });

  it('refuses a stored field whose path is forbidden, at resolve time', () => {
    // A row written before `assertPathPermitted` existed would otherwise still resolve.
    expect(() =>
      service.resolve(
        [
          {
            token: 'aadhaar',
            label: 'Aadhaar',
            sourceType: LetterFieldSource.employee,
            sourcePath: 'aadhaarEncrypted',
            isRequired: false,
          },
        ],
        { employee: { aadhaarEncrypted: 'cipher' } },
        {},
      ),
    ).toThrow(/regulated/);
  });

  it('returns undefined for a path that runs off the end of the record', () => {
    const values = service.resolve(
      [
        {
          token: 'deep',
          label: 'Deep',
          sourceType: LetterFieldSource.employee,
          sourcePath: 'a.b.c.d',
          isRequired: false,
        },
      ],
      { employee: { a: 'not an object' } },
      {},
    );
    expect(values.deep).toBe('');
  });
});

/**
 * Which templates a field removal would break (017 FR-011b, web T136).
 *
 * Matched by tokenising rather than by substring. A field named `site` reported as used by a
 * template referencing `{{siteName}}` would make the warning cry wolf, and a warning that is
 * usually wrong is a warning people click past — including the time it was right.
 */
describe('LetterKindFieldsService.templatesUsingField', () => {
  const build = (
    templates: {
      id: string;
      name: string;
      bodyTemplate: string;
      isActive: boolean;
    }[],
  ) => {
    const tx = {
      $executeRaw: async () => 0,
      letterTemplate: { findMany: async () => templates },
    };
    const prisma = {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    };
    return new LetterKindFieldsService(prisma as never);
  };
  const ctx = { isSuperAdmin: true } as never;

  const TEMPLATES = [
    {
      id: 't1',
      name: 'Offer, standard',
      bodyTemplate: 'Posted at {{siteName}} under {{reportingManager}}.',
      isActive: true,
    },
    {
      id: 't2',
      name: 'Offer, trainee',
      bodyTemplate: 'Welcome {{candidateName}}.',
      isActive: false,
    },
  ];

  it('names the templates that reference the field', async () => {
    const service = build(TEMPLATES);

    await expect(
      service.templatesUsingField(ctx, 'kind-1', 'siteName'),
    ).resolves.toEqual([{ id: 't1', name: 'Offer, standard', isActive: true }]);
  });

  it('does not report a template that merely contains the token as a substring', async () => {
    // `site` is a prefix of `siteName`. A substring match would report t1 and the administrator
    // would learn to ignore the warning.
    const service = build(TEMPLATES);

    await expect(
      service.templatesUsingField(ctx, 'kind-1', 'site'),
    ).resolves.toEqual([]);
  });

  it('returns nothing when no template uses it, rather than failing', async () => {
    // The common case — a field declared and not yet used. It must read as "nothing will break",
    // which is a different answer from an error, and the screen renders them differently.
    const service = build(TEMPLATES);

    await expect(
      service.templatesUsingField(ctx, 'kind-1', 'neverUsed'),
    ).resolves.toEqual([]);
  });

  it('reports a draft template as well as a live one', async () => {
    const service = build(TEMPLATES);

    // Both, and `isActive` tells them apart. The api does not refuse the removal, so the
    // administrator decides — and "one live template and one draft" is a different decision from
    // "two live templates".
    await expect(
      service.templatesUsingField(ctx, 'kind-1', 'candidateName'),
    ).resolves.toEqual([{ id: 't2', name: 'Offer, trainee', isActive: false }]);
  });
});
