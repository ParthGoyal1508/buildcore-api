import { CheckListAnswer } from '@prisma/client';

/**
 * The six check-list questions, in order, in the client's own words (023 US6, FR-041 to FR-043a).
 *
 * ## Why a constant and not a table
 *
 * **Their wording and their order are the client's format, not this system's data.** A reviewer
 * reads them by position — question 4 is the bar-bending schedule, every month, on every package —
 * so a configurable list would let one company's bill mean something different from another's while
 * both printed "4". And a question somebody edits is a question whose historical answers stop
 * meaning what they meant.
 *
 * The wording below is transcribed from page 1 of `docs/Parth Realcon Pvt Ltd. RA-12 (1).pdf`
 * **including its spelling**: "reciept", "dispached", "Reconcilication", "duly review". That is
 * deliberate. The document is the thing the client signs and recognises, and a silently corrected
 * form is a different document — the same judgement FR-032 makes about a deduction's reason. If they
 * want the spelling fixed, that is a change to the format and they should ask for it.
 */
export interface CheckListQuestion {
  /** Stable key, stored on the answer row. Independent of the wording, so a future correction to
   * the text does not orphan every historical answer. */
  key: string;
  /** Position on the sheet, 1-based. The client reads by this. */
  position: number;
  text: string;
}

export const CHECK_LIST_QUESTIONS: readonly CheckListQuestion[] = [
  {
    key: 'cumulative_measurement',
    position: 1,
    text: 'Is cumulative measurement including this bill, Attached?',
  },
  {
    key: 'material_issue_receipt',
    position: 2,
    text: 'Is material issued and reciept till this bills, Attached?',
  },
  {
    key: 'rmc_dispatch_detail',
    position: 3,
    text: 'Is RMC dispached detail till this bills, Attached?',
  },
  {
    key: 'bar_bending_schedule',
    position: 4,
    text: 'Is BBS for this bill, Attached?',
  },
  {
    key: 'material_reconciliation',
    position: 5,
    text: 'Is Reconcilication for RMC, STEEL, Shuttering Material and others, Attached?',
  },
  {
    key: 'debit_note_reviewed',
    position: 6,
    text: 'Is Debit Note duly review by Planning dept in line with the Scope of Work, Attached?',
  },
] as const;

/**
 * The footer the client's own sheet carries, verbatim.
 *
 * Reproduced rather than paraphrased because it is what makes the check list a control: it names
 * whose responsibility compliance is, and what happens when it is not met. A sheet with the
 * questions and without this is a form nobody is accountable for.
 */
export const CHECK_LIST_FOOTER =
  'Please Note: compliances of the above said check list points is responsibility of Planning ' +
  'head and Project Head., None Compliance of any obligation may delay the process of bill/ ' +
  'deduction in amount.';

/** The two signature blocks beneath it. */
export const CHECK_LIST_SIGNATORIES = ['Prepared by', 'Checked By'] as const;

export const CHECK_LIST_KEYS: readonly string[] = CHECK_LIST_QUESTIONS.map(
  (question) => question.key,
);

/** One question as a caller reads it, with whatever has been answered. */
export interface CheckListItem extends CheckListQuestion {
  /**
   * **Null means unanswered, which is not an answer of no** (FR-042).
   *
   * A boolean could not carry the distinction, and the distinction is the whole point: "we checked
   * and it is not attached" and "nobody has looked" call for different actions from the person
   * holding the bill.
   */
  answer: CheckListAnswer | null;
  answeredAt: string | null;
}

/**
 * The six questions, every one present, with the answers that exist merged in.
 *
 * **Every question comes back whether or not it has been answered** — the same reasoning as 022's
 * FR-037 about BOQ lines: a question absent from a response and a question answered no are
 * indistinguishable to the caller, and the caller is a document somebody signs.
 */
export function mergeCheckList(
  stored: {
    questionKey: string;
    answer: CheckListAnswer | null;
    answeredAt: Date | null;
  }[],
): CheckListItem[] {
  const byKey = new Map(stored.map((row) => [row.questionKey, row]));
  return CHECK_LIST_QUESTIONS.map((question) => {
    const row = byKey.get(question.key);
    return {
      ...question,
      answer: row?.answer ?? null,
      answeredAt: row?.answeredAt?.toISOString() ?? null,
    };
  });
}

/**
 * The gaps, as FR-043a requires them **reported to the caller issuing the bill** (FR-043).
 *
 * A gap is an unanswered question or one answered no. Neither refuses an issue — the client's own
 * footer says only that non-compliance "may delay the process", which is a human judgement and not
 * a validation rule. "MUST report the gaps" with no addressee would be satisfied by storing them
 * where nobody looks, which is why this is returned rather than written.
 */
export function checkListGaps(items: CheckListItem[]): {
  position: number;
  key: string;
  text: string;
  state: 'unanswered' | 'no';
}[] {
  return items
    .filter(
      (item) => item.answer === null || item.answer === CheckListAnswer.no,
    )
    .map((item) => ({
      position: item.position,
      key: item.key,
      text: item.text,
      state: item.answer === null ? ('unanswered' as const) : ('no' as const),
    }));
}
