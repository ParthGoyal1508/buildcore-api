import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsBase64Payload } from '../../../common/uploads/base64-payload';

/**
 * A delivery recorded at the site (043). Partial by design: the vendor, quantity, rate and bill are
 * Head Office's to add. The location fields are the attendance punch's, checked by the same rule.
 */
export class CreateSiteEntryDto {
  @ApiPropertyOptional({
    description:
      "Which of the caller's assigned sites, when they have more than one. Ignored when they have " +
      'one, and refused (403) when it is not one of theirs — the store always comes from the assignment.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  siteId?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  itemId!: string;

  @ApiProperty({
    description: 'When the delivery arrived, ISO 8601. Not in the future.',
    example: '2026-10-25T09:30:00.000Z',
  })
  @IsISO8601()
  deliveredAt!: string;

  @ApiProperty({
    description:
      'Stored uppercase with every space removed: "mh 12 ab 1234" → "MH12AB1234".',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  vehicleNo!: string;

  @ApiProperty({
    description:
      'The delivery photographed live, base64-encoded (data-URL prefix optional).',
  })
  @IsString()
  @IsNotEmpty()
  @IsBase64Payload()
  photo!: string;

  @ApiProperty({ example: 19.076 })
  @Type(() => Number)
  @IsLatitude()
  latitude!: number;

  @ApiProperty({ example: 72.8777 })
  @Type(() => Number)
  @IsLongitude()
  longitude!: number;

  @ApiProperty({
    description:
      "The GPS accuracy the phone reported, in metres. Required here, unlike the punch's: it is " +
      'stored as evidence with the entry.',
    example: 25,
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(10_000)
  accuracyMeters!: number;

  @ApiProperty({
    description:
      'When the photo and fix were taken, ISO 8601. Refused when more than 10 minutes old or 5 ahead.',
  })
  @IsISO8601()
  capturedAt!: string;

  @ApiProperty({
    description:
      'A UUID the page makes once per entry. Sending it again returns the entry already saved.',
  })
  @IsUUID()
  clientRequestId!: string;
}

export class SiteEntryItemsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}
