import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  IsDateString,
} from 'class-validator';

export class VerifyDocumentDto {
  @ApiPropertyOptional() @IsOptional() @IsString() documentNumber?: string;
  @ApiPropertyOptional({ example: '2030-01-01' })
  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  @ApiProperty({ description: 'Base64/data-URL document' })
  @IsString()
  @IsNotEmpty()
  file!: string;

  @ApiProperty({ example: 'application/pdf' })
  @IsString()
  @IsNotEmpty()
  contentType!: string;
}

export class IssueKitDto {
  @ApiProperty({ example: 1 }) @IsInt() @Min(1) quantity!: number;
}

export class WaiveItemDto {
  @ApiProperty() @IsString() @IsNotEmpty() reason!: string;
}
