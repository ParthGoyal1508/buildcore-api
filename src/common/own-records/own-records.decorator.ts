import { SetMetadata } from '@nestjs/common';

export const OWN_RECORDS_KEY = 'ownRecords';

/**
 * Marks a controller whose routes read or write the **caller's own** records — their punches,
 * leave, claims, payslips, profile (058).
 *
 * For an all-companies user the request otherwise works in the company they selected, and their
 * own employee record (which lives in their home company) would not be found there. On a marked
 * controller `OwnRecordsInterceptor` puts the request back in the home company. Everyone else is
 * unaffected.
 *
 * Every `@Controller('my…')` must carry it, except the two that follow the working company on
 * purpose (`my/cash-policy`, `my/company-selection`) — `own-records.coverage.spec.ts` checks.
 */
export const OwnRecords = () => SetMetadata(OWN_RECORDS_KEY, true);
