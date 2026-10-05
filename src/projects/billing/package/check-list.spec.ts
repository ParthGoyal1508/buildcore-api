import { CheckListAnswer } from '@prisma/client';

import {
  CHECK_LIST_FOOTER,
  CHECK_LIST_KEYS,
  CHECK_LIST_QUESTIONS,
  checkListGaps,
  mergeCheckList,
} from './check-list';

/**
 * The check list (023 US6, task T064, FR-041 to FR-043a).
 *
 * Six fixed questions, in a fixed order, in the client's own words. The tests below pin the wording
 * because the sheet is what the client signs and recognises: a reviewer finds question 4 by its
 * position every month, and a silently reworded question is a different document.
 */
describe('the six questions', () => {
  it('are six, in the client’s own order', () => {
    expect(CHECK_LIST_QUESTIONS).toHaveLength(6);
    expect(CHECK_LIST_QUESTIONS.map((question) => question.position)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it('carry the client’s wording, misspellings included', () => {
    // Transcribed from page 1 of the real package. "reciept", "dispached", "Reconcilication" and
    // "duly review" are the document's, and correcting them silently would make the sheet one the
    // client does not recognise — the same judgement FR-032 makes about a deduction's reason. If
    // they want the spelling fixed, that is a change to the format and they should ask for it.
    const byPosition = CHECK_LIST_QUESTIONS.map((question) => question.text);

    expect(byPosition[0]).toBe(
      'Is cumulative measurement including this bill, Attached?',
    );
    expect(byPosition[1]).toContain('reciept');
    expect(byPosition[2]).toContain('dispached');
    expect(byPosition[3]).toBe('Is BBS for this bill, Attached?');
    expect(byPosition[4]).toContain('Reconcilication');
    expect(byPosition[5]).toContain('duly review by Planning dept');
  });

  it('have keys independent of their wording', () => {
    // So a future correction to the text does not orphan every historical answer.
    expect(CHECK_LIST_KEYS).toEqual([
      'cumulative_measurement',
      'material_issue_receipt',
      'rmc_dispatch_detail',
      'bar_bending_schedule',
      'material_reconciliation',
      'debit_note_reviewed',
    ]);
  });

  it('carry the footer that makes the list a control', () => {
    // A sheet with the questions and without this is a form nobody is accountable for: the footer
    // is what names whose responsibility compliance is, and what happens when it is not met.
    expect(CHECK_LIST_FOOTER).toContain('Planning head and Project Head');
    expect(CHECK_LIST_FOOTER).toContain('may delay the process');
  });
});

describe('merging the stored answers', () => {
  it('returns all six whether or not they have been answered', () => {
    // The same reasoning 022's FR-037 applies to BOQ lines: a question absent from a response and a
    // question answered no are indistinguishable to the caller, and the caller is a document
    // somebody signs.
    const items = mergeCheckList([
      {
        questionKey: 'bar_bending_schedule',
        answer: CheckListAnswer.not_required,
        answeredAt: new Date('2026-02-03'),
      },
    ]);

    expect(items).toHaveLength(6);
    expect(items[3].answer).toBe(CheckListAnswer.not_required);
    expect(items[3].answeredAt).toContain('2026-02-03');
  });

  it('keeps unanswered distinguishable from answered no', () => {
    // FR-042, and the reason the column is nullable rather than a boolean. "We checked and it is
    // not attached" and "nobody has looked" call for different actions from whoever is holding the
    // bill, and a boolean cannot carry the difference.
    const items = mergeCheckList([
      {
        questionKey: 'cumulative_measurement',
        answer: CheckListAnswer.no,
        answeredAt: new Date('2026-02-03'),
      },
    ]);

    expect(items[0].answer).toBe(CheckListAnswer.no);
    expect(items[1].answer).toBeNull();
    expect(items[0].answer).not.toBe(items[1].answer);
  });

  it('ignores a stored answer to a question that no longer exists', () => {
    // A key retired from the format leaves rows behind. They are dropped from the sheet rather than
    // printed as a seventh question, because the sheet's shape is the client's and not the data's.
    const items = mergeCheckList([
      {
        questionKey: 'retired_question',
        answer: CheckListAnswer.yes,
        answeredAt: null,
      },
    ]);

    expect(items).toHaveLength(6);
    expect(items.every((item) => item.answer === null)).toBe(true);
  });
});

describe('the gaps', () => {
  it('counts an unanswered question and one answered no, and says which it is', () => {
    // FR-043a. Reported to the caller issuing the bill rather than stored: "MUST report the gaps"
    // with no addressee is satisfied by writing them where nobody looks.
    const items = mergeCheckList([
      {
        questionKey: 'cumulative_measurement',
        answer: CheckListAnswer.yes,
        answeredAt: null,
      },
      {
        questionKey: 'material_issue_receipt',
        answer: CheckListAnswer.no,
        answeredAt: null,
      },
      {
        questionKey: 'rmc_dispatch_detail',
        answer: CheckListAnswer.not_required,
        answeredAt: null,
      },
    ]);

    const gaps = checkListGaps(items);

    // Question 1 is attached and 3 is not required — neither is a gap. Question 2 is a no, and
    // 4, 5 and 6 are unanswered.
    expect(gaps.map((gap) => gap.position)).toEqual([2, 4, 5, 6]);
    expect(gaps[0].state).toBe('no');
    expect(gaps[1].state).toBe('unanswered');
  });

  it('is empty when every question is attached or not required', () => {
    const items = mergeCheckList(
      CHECK_LIST_KEYS.map((questionKey, index) => ({
        questionKey,
        answer:
          index % 2 === 0 ? CheckListAnswer.yes : CheckListAnswer.not_required,
        answeredAt: null,
      })),
    );

    expect(checkListGaps(items)).toEqual([]);
  });

  it('never refuses anything, which is the whole of FR-043', () => {
    // The client's own footer says non-compliance "may delay the process" — a human judgement, not
    // a validation rule. A bill blocked by an unticked box is a bill nobody can send while the
    // person who could tick it is on site.
    const nothingAnswered = mergeCheckList([]);

    expect(checkListGaps(nothingAnswered)).toHaveLength(6);
    // And the function's only job is to describe them. It returns, it does not throw.
    expect(() => checkListGaps(nothingAnswered)).not.toThrow();
  });
});
