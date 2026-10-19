import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentInstrument, SignedCopySubject } from '@prisma/client';
import {
  IsDateString,
  IsIn,
  Matches,
  IsEnum,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { IsBase64Payload } from '../../../../common/uploads/base64-payload';

/** The modes a payment advice names. Each maps onto an `instrument` for the ledger. */
export const PAYMENT_MODES = [
  'NEFT',
  'RTGS',
  'IMPS',
  'UPI',
  'Cheque',
  'Cash',
] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export class RecordPaymentDto {
  @ApiProperty({
    example: '2026-09-28',
    description: 'When the money left, which is not when it was recorded.',
  })
  @IsDateString()
  paidOn!: string;

  @ApiProperty({
    example: '600000.00',
    description:
      'A string, not a number. The figure is a `Decimal(18,2)` and a JSON number cannot carry ' +
      'every paisa exactly — a payment that arrives as 599999.99999 reconciles against nothing.',
  })
  @IsNumberString()
  amount!: string;

  @ApiProperty({ enum: PaymentInstrument, example: 'bank_transfer' })
  @IsEnum(PaymentInstrument)
  instrument!: PaymentInstrument;

  @ApiPropertyOptional({
    example: 'UTR 316902847561',
    description:
      'UTR, cheque number, adjustment memo. Free text because every bank spells it differently.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;

  @ApiPropertyOptional({ example: 'Part payment against RA-03.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;

  @ApiPropertyOptional({
    example: 'R52025101874160134',
    description:
      'The bank’s own transaction number, distinct from the reference (UTR). Both print on the ' +
      'payment advice.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  transactionNo?: string;

  @ApiPropertyOptional({
    example: '0.00',
    description:
      'Tax deducted at source on this payment, printed on the payment advice. Not subtracted ' +
      'from `amount`, which is what was actually paid.',
  })
  @IsOptional()
  @IsNumberString()
  tdsAmount?: string;

  @ApiPropertyOptional({
    enum: PAYMENT_MODES,
    example: 'NEFT',
    description:
      'How the money moved. Printed on the payment advice as *Bank Transaction Mode*.',
  })
  @IsOptional()
  @IsIn(PAYMENT_MODES)
  mode?: PaymentMode;

  @ApiPropertyOptional({
    example: '10/2026-27',
    description:
      'The advice’s *Particulars* — usually the payment voucher number. The bill number prints ' +
      'when this is left out.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  particulars?: string;
}

/** A payee's bank details, filled in from the bill when the vendor record lacks them. */
export class SetPayeeBankDto {
  @ApiPropertyOptional({ example: 'Bank of Baroda' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  bankName?: string;

  @ApiPropertyOptional({ example: 'Deoli' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  bankBranch?: string;

  @ApiPropertyOptional({ example: '09310400000526' })
  @IsOptional()
  @Matches(/^[0-9A-Za-z]{6,34}$/, {
    message: 'bankAccountNumber must be 6 to 34 letters or digits',
  })
  bankAccountNumber?: string;

  @ApiPropertyOptional({ example: 'Tirupati Enterprises' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  bankAccountHolderName?: string;

  @ApiPropertyOptional({ example: 'BARB0DEOLIX' })
  @IsOptional()
  @Matches(/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/, {
    message:
      'ifscCode must look like BARB0DEOLIX — four letters, a zero, six characters',
  })
  ifscCode?: string;
}

export class UploadSignedCopyDto {
  @ApiProperty({
    enum: SignedCopySubject,
    description: 'Which document came back signed.',
  })
  @IsEnum(SignedCopySubject)
  subjectType!: SignedCopySubject;

  @ApiProperty({ description: 'The file, base64-encoded.' })
  @IsString()
  @IsNotEmpty()
  @IsBase64Payload()
  data!: string;

  @ApiProperty({
    example: 'RA-03 signed by Shree Construction.pdf',
    description:
      'As the uploader’s own filesystem spells it. Stored and served back verbatim so the ' +
      'download arrives named, rather than as the opaque storage reference.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName!: string;

  @ApiProperty({
    example: '2026-10-02',
    description:
      'When the signed copy was **received**, which is not when it was scanned. A copy signed on ' +
      'site on Tuesday and uploaded on Friday was acknowledged on Tuesday, and the acknowledgement ' +
      'date is what a retention or payment term runs from.',
  })
  @IsDateString()
  receivedOn!: string;
}
