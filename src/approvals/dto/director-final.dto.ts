import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';

/** One action type's new mark. */
export class DirectorFinalChangeDto {
  @ApiProperty({ example: 'payment_release' })
  @IsString()
  @Length(1, 100)
  actionType: string;

  @ApiProperty()
  @IsBoolean()
  isFinal: boolean;
}

/**
 * A proposed change to the director-final set (016 FR-018b).
 *
 * Several changes in one request, because a reviewer should approve a coherent set rather
 * than seven separate items that only make sense together.
 */
export class UpdateDirectorFinalSetDto {
  @ApiProperty({ type: [DirectorFinalChangeDto] })
  @IsArray()
  @ArrayMinSize(1)
  // Bounded: this becomes an approval payload, and an unbounded array is an unbounded row.
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => DirectorFinalChangeDto)
  changes: DirectorFinalChangeDto[];
}
