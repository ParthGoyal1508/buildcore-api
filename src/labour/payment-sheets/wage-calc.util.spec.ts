import { AttendanceType } from '@prisma/client';

import {
  computeWage,
  dayFractionOf,
  roundMoney,
  WorkedDay,
} from './wage-calc.util';

describe('wage-calc.util', () => {
  describe('dayFractionOf', () => {
    it('maps attendance types to day fractions', () => {
      expect(dayFractionOf(AttendanceType.full_day)).toBe(1);
      expect(dayFractionOf(AttendanceType.half_day)).toBe(0.5);
      expect(dayFractionOf(AttendanceType.absent)).toBe(0);
      expect(dayFractionOf(AttendanceType.overtime_only)).toBe(0);
    });
  });

  describe('computeWage', () => {
    it('sums day fractions times each day rate', () => {
      const days: WorkedDay[] = [
        {
          attendanceType: AttendanceType.full_day,
          overtimeHours: 0,
          dailyRate: 800,
        },
        {
          attendanceType: AttendanceType.half_day,
          overtimeHours: 0,
          dailyRate: 800,
        },
      ];
      const result = computeWage(days, 8, 2);
      expect(result.daysWorked).toBe(1.5);
      expect(result.grossWage).toBe(1200);
      expect(result.overtimeHours).toBe(0);
    });

    it('prices overtime at hourly rate times the company OT multiplier', () => {
      // 2h OT on an 800/day, 8h-standard, 2x-multiplier day = 2 * (800/8) * 2 = 400.
      const days: WorkedDay[] = [
        {
          attendanceType: AttendanceType.full_day,
          overtimeHours: 2,
          dailyRate: 800,
        },
      ];
      const result = computeWage(days, 8, 2);
      expect(result.overtimeHours).toBe(2);
      expect(result.grossWage).toBe(1200);
    });

    it('pays overtime-only days without a base day fraction', () => {
      const days: WorkedDay[] = [
        {
          attendanceType: AttendanceType.overtime_only,
          overtimeHours: 4,
          dailyRate: 800,
        },
      ];
      const result = computeWage(days, 8, 2);
      expect(result.daysWorked).toBe(0);
      // 4 * (800/8) * 2 = 800.
      expect(result.grossWage).toBe(800);
    });

    it('prices a mid-period rate change per day', () => {
      const days: WorkedDay[] = [
        {
          attendanceType: AttendanceType.full_day,
          overtimeHours: 0,
          dailyRate: 800,
        },
        {
          attendanceType: AttendanceType.full_day,
          overtimeHours: 0,
          dailyRate: 850,
        },
      ];
      const result = computeWage(days, 8, 2);
      expect(result.grossWage).toBe(1650);
    });
  });

  describe('roundMoney', () => {
    it('rounds to two decimals', () => {
      expect(roundMoney(1200.005)).toBe(1200.01);
      expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    });
  });
});
