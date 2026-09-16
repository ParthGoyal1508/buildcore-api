import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBase64,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * A named signatory and their signature graphic (017 FR-016).
 *
 * The 2026-09-15 clarification settled what "digital signature" means here: an
 * authorised signature **image** applied to a rendered document, not a legally
 * recognised Digital Signature Certificate under the IT Act. Those differ in cost,
 * workflow and legal effect, and this DTO implements the first.
 */
export class CreateSignatoryDto {
  @ApiProperty({ example: 'Sunil Agarwal' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @ApiProperty({
    description: 'Printed beneath the signature.',
    example: 'Director',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title: string;

  @ApiProperty({
    description: 'The signature graphic, base64-encoded (PNG or JPEG).',
  })
  @IsBase64()
  signature: string;

  @ApiPropertyOptional({ example: 'image/png' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  contentType?: string;
}

export class UpdateSignatoryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional({
    description:
      'Replacing the graphic changes what FUTURE letters carry. Letters already issued ' +
      'keep the image applied at the time — see `IssuedLetter.appliedSignatureRef`.',
  })
  @IsOptional()
  @IsBase64()
  signature?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  contentType?: string;

  @ApiPropertyOptional({
    description:
      'Someone leaves; the letters they signed stay valid. Deactivating hides them from ' +
      'new issues without touching what was already issued.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
