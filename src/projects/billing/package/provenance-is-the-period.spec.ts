import { readFileSync } from 'fs';
import { join } from 'path';

import { stripComments } from '../../../common/strip-comments';

/**
 * **No row links a bill claim to an individual daily work report** (023 FR-049, decision D3) — T078a.
 *
 * ## Why a prohibition needs a test
 *
 * A bill line's provenance *is* its line and its bill's period. One line of one schedule is billed
 * once in one period (FR-002, FR-002a, FR-007), so the measurement it consumed is exactly the
 * approved measurement for that line in that period — true by construction, with nothing to
 * maintain and nothing that can drift.
 *
 * Decision D3 chose that over explicit links, and the reasoning was that a row per report per line
 * per bill is, for a 312-line tender over a year of daily reporting, hundreds of thousands of rows
 * whose only consumer is an audit question nobody has yet asked.
 *
 * **But the decision is load-bearing in a way that is easy to forget.** Feature 022's reversal guard
 * stays a *quantity floor* — it refuses a reversal that would drop a line's executed quantity below
 * what has been billed — precisely because no provenance exists to check instead (FR-049a). Add a
 * link table later as an "improvement", and somebody will tighten 022's guard to use it, and the two
 * mechanisms will disagree about whether a reversal is allowed.
 *
 * A prohibition that nothing checks is a prohibition a later simplification removes, which is why
 * this is a test and not a comment. It is the same shape as 022's own guards, and it strips comments
 * first for the reason `strip-comments.ts` exists: the docblock above would otherwise satisfy its
 * own prohibition.
 */
const SCHEMA = join(__dirname, '../../../../prisma/schema.prisma');

const PACKAGE_MODELS = [
  'BillPackage',
  'BillPackageLineClaim',
  'BillPackageDebit',
  'BillPackageCheckListAnswer',
];

const MEASUREMENT_MODELS = ['DailyWorkReport', 'DWRTask', 'DWRAttachment'];

function modelBody(source: string, model: string): string {
  const match = source.match(
    new RegExp(`\\nmodel ${model} \\{([\\s\\S]*?)\\n\\}`),
  );
  if (!match) throw new Error(`model ${model} not found in schema.prisma`);
  return match[1];
}

describe('provenance is the period, not a recorded link', () => {
  const source = stripComments(readFileSync(SCHEMA, 'utf8'));

  it('finds all four package models, so the rest of this suite means something', () => {
    // Without this the assertions below would pass vacuously against a renamed model — the same
    // non-vacuity reasoning the isolation probe uses, and for the same reason.
    for (const model of PACKAGE_MODELS) {
      expect(() => modelBody(source, model)).not.toThrow();
    }
  });

  it('declares no relation from a package model to a measurement model', () => {
    for (const model of PACKAGE_MODELS) {
      const body = modelBody(source, model);
      for (const measurement of MEASUREMENT_MODELS) {
        expect(body).not.toContain(measurement);
      }
    }
  });

  it('declares no relation from a measurement model to a package model', () => {
    // The back-relation half. Prisma needs both sides, so either one appearing is the link.
    for (const model of MEASUREMENT_MODELS) {
      const body = modelBody(source, model);
      for (const pkg of PACKAGE_MODELS) {
        expect(body).not.toContain(pkg);
      }
    }
  });

  it('carries no column that would hold a report id on a claim', () => {
    const body = modelBody(source, 'BillPackageLineClaim');

    expect(body).not.toMatch(/dwrId/i);
    expect(body).not.toMatch(/dailyWorkReport/i);
    expect(body).not.toMatch(/reportIds/i);
  });
});
