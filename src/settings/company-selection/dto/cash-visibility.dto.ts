import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/** The cash visibility toggle (019 FR-014). */
export class CashVisibilityDto {
  @ApiProperty({
    description:
      'True hides every cash transaction (screens, totals, reports, exports) and blocks ' +
      'new cash entries for everyone until turned off (038). No data is altered.',
  })
  @IsBoolean()
  hideCashTransactions: boolean;
}
