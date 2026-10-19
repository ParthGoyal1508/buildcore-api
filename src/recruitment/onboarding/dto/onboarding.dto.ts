import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsBase64Payload } from '../../../common/uploads/base64-payload';

export class VerifyDocumentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  @IsOptional()
  @MaxLength(200)
  documentNumber?: string;
  @ApiPropertyOptional({ example: '2030-01-01' })
  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  @ApiProperty({ description: 'Base64/data-URL document' })
  @IsString()
  @IsNotEmpty()
  @IsBase64Payload()
  file!: string;

  @ApiProperty({ example: 'application/pdf' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  contentType!: string;
}

export class IssueKitDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  @ApiProperty({ example: 1 })
  @IsInt()
  @Max(2_147_483_647)
  quantity!: number;
}

export class WaiveItemDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @ApiProperty()
  @IsString()
  @MaxLength(2_000)
  reason!: string;
}
