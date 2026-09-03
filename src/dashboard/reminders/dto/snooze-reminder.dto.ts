import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Body of `PATCH /dashboard/reminders/:id/snooze` (spec FR-034). */
export class SnoozeReminderDto {
  @ApiProperty({
    example: '2026-10-15',
    description:
      'Inclusive calendar date. The reminder reappears the following day, whether ' +
      'or not its severity escalated in the meantime.',
  })
  @IsDateString()
  snoozeUntil!: string;

  @ApiProperty({
    example: 'Renewal already lodged with the RTO, receipt pending',
    description:
      'Required. A snooze with no stated reason is indistinguishable from ' +
      'ignoring the reminder, and this row is what the audit trail shows.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
