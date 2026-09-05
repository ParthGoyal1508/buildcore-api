import { BadRequestException } from '@nestjs/common';
import { AssetStatus } from '@prisma/client';

import {
  assertTransition,
  AVAILABLE_STATUSES,
  canTransition,
  REMINDABLE_STATUSES,
} from './asset-status';

describe('canTransition', () => {
  it('allows the lifecycle moves the spec lists (FR-007)', () => {
    expect(canTransition(AssetStatus.not_in_service, AssetStatus.idle)).toBe(
      true,
    );
    expect(canTransition(AssetStatus.idle, AssetStatus.allocated)).toBe(true);
    expect(canTransition(AssetStatus.allocated, AssetStatus.idle)).toBe(true);
    expect(canTransition(AssetStatus.allocated, AssetStatus.under_repair)).toBe(
      true,
    );
    expect(canTransition(AssetStatus.under_repair, AssetStatus.idle)).toBe(
      true,
    );
  });

  it('refuses dispatching an allocated asset (US5 scenario 2)', () => {
    expect(canTransition(AssetStatus.allocated, AssetStatus.in_transit)).toBe(
      false,
    );
  });

  it('treats scrapped as terminal', () => {
    for (const status of Object.values(AssetStatus)) {
      if (status === AssetStatus.scrapped) continue;
      expect(canTransition(AssetStatus.scrapped, status)).toBe(false);
    }
  });

  it('treats a same-status move as a no-op rather than an error', () => {
    expect(canTransition(AssetStatus.idle, AssetStatus.idle)).toBe(true);
  });
});

describe('assertTransition', () => {
  it('names the permitted transitions when it refuses (FR-007)', () => {
    expect(() =>
      assertTransition(
        AssetStatus.allocated,
        AssetStatus.in_transit,
        'DC-AST-0001',
      ),
    ).toThrow(BadRequestException);

    try {
      assertTransition(
        AssetStatus.allocated,
        AssetStatus.in_transit,
        'DC-AST-0001',
      );
      fail('expected a refusal');
    } catch (error) {
      const message = (error as BadRequestException).message;
      expect(message).toContain('DC-AST-0001');
      expect(message).toContain('idle');
      expect(message).toContain('under_repair');
      expect(message).toContain('scrapped');
    }
  });

  it('says so plainly when the asset is already final', () => {
    try {
      assertTransition(AssetStatus.scrapped, AssetStatus.idle, 'DC-AST-0002');
      fail('expected a refusal');
    } catch (error) {
      expect((error as BadRequestException).message).toContain('final');
    }
  });

  it('permits a move that is on the machine', () => {
    expect(() =>
      assertTransition(AssetStatus.idle, AssetStatus.allocated, 'DC-AST-0003'),
    ).not.toThrow();
  });
});

describe('status sets', () => {
  it('only allocates from idle', () => {
    expect([...AVAILABLE_STATUSES]).toEqual([AssetStatus.idle]);
  });

  it('never reminds about a scrapped asset (FR-027)', () => {
    expect(REMINDABLE_STATUSES).not.toContain(AssetStatus.scrapped);
    expect(REMINDABLE_STATUSES).toHaveLength(
      Object.values(AssetStatus).length - 1,
    );
  });
});
