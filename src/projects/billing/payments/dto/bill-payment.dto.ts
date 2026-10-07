import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentInstrument, SignedCopySubject } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

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
