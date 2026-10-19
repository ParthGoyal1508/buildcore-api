import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
} from 'class-validator';

export class CreateBocwPaymentDto {
  @ApiProperty({ description: 'Must be greater than zero' })
  @IsNumber()
  @IsPositive()
  @Max(999_999_999_999.99)
  amountPaid: number;

  @ApiProperty({ description: 'ISO date' })
  @IsDateString()
  paymentDate: string;

  @ApiProperty({ description: 'Challan or transfer reference' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  referenceNumber: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}
