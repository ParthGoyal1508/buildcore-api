import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateBocwPaymentDto {
  @ApiProperty({ description: 'Must be greater than zero' })
  @IsNumber()
  @IsPositive()
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
