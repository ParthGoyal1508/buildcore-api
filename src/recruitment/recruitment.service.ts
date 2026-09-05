import { Injectable } from '@nestjs/common';
import { LetterType } from '@prisma/client';

import { AuthenticatedUser } from '../auth/authenticated-user';
import { RlsContext } from '../common/prisma/rls-context';
import { LetterService } from './letters/letter.service';
import { ResignationService } from './resignations/resignation.service';

/**
 * The recruitment module's outward contract (011).
 *
 * `getAcceptedResignation` is the seam feature 005's exit flow reads a resignation's
 * agreed last working day through (011 FR-065). `generateEmployeeLetter` is the
 * letter-generation seam 005's F&F flow calls for relieving letters — both exported
 * here so 005 depends on this service, never on the recruitment schema.
 */
@Injectable()
export class RecruitmentService {
  constructor(
    private readonly resignations: ResignationService,
    private readonly letters: LetterService,
  ) {}

  getAcceptedResignation(employeeId: string, ctx?: RlsContext) {
    return this.resignations.getAcceptedResignation(employeeId, ctx);
  }

  generateEmployeeLetter(
    caller: AuthenticatedUser,
    employeeId: string,
    letterType: LetterType,
    ipAddress: string,
  ) {
    return this.letters.generateForEmployee(
      caller,
      { letterType, employeeId },
      ipAddress,
    );
  }
}
