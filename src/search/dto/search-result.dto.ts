import { ApiProperty } from '@nestjs/swagger';

import { SearchRegister } from '../search-source.interface';

/**
 * One row of a search response (021 FR-003, FR-004).
 *
 * An identifying summary plus a route — deliberately **never a domain object**. That is
 * what keeps `src/search/` from learning any register's business rules: this module
 * cannot accidentally depend on what a project *is* if all it ever holds is seven
 * strings.
 */
export class SearchResult {
  @ApiProperty({
    enum: ['employee', 'vendor', 'equipment', 'project'],
    description: 'Which register this result belongs to (FR-003).',
  })
  register!: SearchRegister;

  @ApiProperty()
  id!: string;

  @ApiProperty({ description: "The register's own code." })
  code!: string;

  @ApiProperty({ description: 'What a person reads — the name.' })
  label!: string;

  @ApiProperty({
    nullable: true,
    description:
      'One disambiguating fact, for the case of two records sharing a name.',
  })
  sublabel!: string | null;

  @ApiProperty({
    enum: ['code', 'name'],
    description:
      'Why this row is in the list. Drives the ranking in FR-001b and lets the ' +
      'interface show the reader which field matched.',
  })
  matchedOn!: 'code' | 'name';

  @ApiProperty({ description: 'Where the full record lives (FR-004).' })
  href!: string;
}

/** The merged response across every register the caller may search. */
export class SearchResponse {
  @ApiProperty({
    type: [SearchResult],
    description: 'Exact code matches first (FR-001b), then everything else.',
  })
  results!: SearchResult[];

  @ApiProperty({
    description:
      'A cap was hit and there are more matches than are shown. The spec’s ' +
      '"a search that would match thousands" edge case, answered by admitting it ' +
      'rather than silently returning the first handful.',
  })
  truncated!: boolean;

  @ApiProperty({
    type: [String],
    description:
      'Registers whose module could not be asked — not deployed, or it threw. ' +
      'NEVER a register the caller lacks permission for: see the warning on the ' +
      'registry.',
  })
  unavailableSources!: string[];
}
