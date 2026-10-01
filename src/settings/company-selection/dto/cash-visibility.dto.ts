import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/** The cash visibility toggle (019 FR-014). */
export class CashVisibilityDto {
  @ApiProperty({
    description:
      'True hides cash amounts across screens, reports and exports. A display control ' +
      'only — no data is altered (FR-017).',
  })
  @IsBoolean()
  hideCashTransactions: boolean;
}
