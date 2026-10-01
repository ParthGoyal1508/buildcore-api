import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** The acceptable GPS accuracy for a punch, in metres (020 FR-012b). */
export class SetPunchAccuracyDto {
  @ApiPropertyOptional({
    minimum: 0,
    maximum: 10_000,
    description:
      'Metres. Omit or send null to clear this company’s decision and follow the product ' +
      'default — which is a different act from setting it to the default’s current value.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  // Bounded for the same reason the punch's own accuracy is: a threshold of a billion metres would
  // accept every punch on Earth, which is the opposite of what a threshold is for.
  @Max(10_000)
  punchAccuracyMaxMetres?: number | null;
}
