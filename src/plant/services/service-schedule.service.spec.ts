import { serviceScheduleStatus } from '../equipment/equipment.service';
import { SERVICE_DUE_SOON_MARGIN } from '../constants/plant.constants';

/**
 * FR-006 / research.md §4. The derivation is deliberately shared with
 * `EquipmentService`, which renders the same status on the machine detail page —
 * two copies of this comparison is exactly how the register and the schedule list
 * end up disagreeing about whether a service is due.
 */
describe('serviceScheduleStatus (FR-006)', () => {
  it('is ok when the machine is well short of its next service', () => {
    expect(serviceScheduleStatus(1000, 1250)).toBe('ok');
  });

  it('is due_soon inside the margin', () => {
    expect(
      serviceScheduleStatus(1250 - SERVICE_DUE_SOON_MARGIN + 1, 1250),
    ).toBe('due_soon');
  });

  it('is due_soon exactly at the margin', () => {
    // "Within 50" includes 50. A machine 50 hours out is the one the workshop most
    // needs to see, not the first one to fall off the list.
    expect(serviceScheduleStatus(1250 - SERVICE_DUE_SOON_MARGIN, 1250)).toBe(
      'due_soon',
    );
  });

  it('is ok one unit outside the margin', () => {
    expect(
      serviceScheduleStatus(1250 - SERVICE_DUE_SOON_MARGIN - 1, 1250),
    ).toBe('ok');
  });

  it('is overdue exactly on the due reading', () => {
    // Reaching the interval *is* the service falling due, not the last moment
    // before it.
    expect(serviceScheduleStatus(1250, 1250)).toBe('overdue');
  });

  it('is overdue past the due reading', () => {
    expect(serviceScheduleStatus(1400, 1250)).toBe('overdue');
  });
});
