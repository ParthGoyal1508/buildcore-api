import { AssetStatus } from '@prisma/client';

import { AllocationService } from './allocation.service';

/**
 * The return mapping of FR-015, isolated from the service's I/O.
 *
 * Worth its own test because it is the one piece of this module that two flows
 * (return and, later, transfer receipt) must agree on exactly.
 */
describe('AllocationService.statusOnReturn', () => {
  it('condemns an asset returned in a scrap grade', () => {
    expect(
      AllocationService.statusOnReturn({ isDamaged: false, isScrap: true }),
    ).toBe(AssetStatus.scrapped);
  });

  it('sends a damaged return to repair', () => {
    expect(
      AllocationService.statusOnReturn({ isDamaged: true, isScrap: false }),
    ).toBe(AssetStatus.under_repair);
  });

  it('returns a healthy asset to idle', () => {
    expect(
      AllocationService.statusOnReturn({ isDamaged: false, isScrap: false }),
    ).toBe(AssetStatus.idle);
  });

  it('prefers scrap when a grade somehow carries both flags', () => {
    // The masters service refuses to store this combination, but the mapping is
    // total by construction so a legacy row cannot make a return throw.
    expect(
      AllocationService.statusOnReturn({ isDamaged: true, isScrap: true }),
    ).toBe(AssetStatus.scrapped);
  });
});
