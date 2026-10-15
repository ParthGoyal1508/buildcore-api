/**
 * How a letter's values are written on the page, as distinct from what was typed or read off a
 * record (2026-10-15).
 *
 * Every function here is pure and runs at render, over the values a letter was composed with —
 * so the stored composition keeps what HR typed ("20000", "S3", "NEFT") and every render, the
 * first and a reissue alike, prints it the same way. Formatting at the form instead would make
 * the printed figure depend on how somebody happened to type it, which is what the production
 * letters showed: "Rs. 20000" in one annexure row beside "55,000" in the next letter.
 */

/**
 * An amount on the Indian grouping — `6,00,000`, `35,833`, `1,23,45,678.50` — whether it was
 * typed with commas, without, or with a "₹" / "Rs." in front (which the template supplies
 * itself, so it is dropped here rather than printed twice). A trailing "/-" goes for the same
 * reason. The decimals are kept as given: the client's annexure writes nil heads as "0.00".
 *
 * Anything that is not a plain number comes back exactly as given — "N/A", a preview's
 * "[Basic — monthly]", "as per actuals" — because reformatting words is how a letter ends up
 * saying something nobody wrote.
 */
export function formatIndianAmount(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  const bare = trimmed
    .replace(/^(₹|rs\.?|inr)\s*/i, '')
    .replace(/\/-$/, '')
    .replace(/[,\s]/g, '');
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(bare);
  if (!match) return raw;
  const [, sign, digits, fraction = ''] = match;
  const whole = digits.replace(/^0+(?=\d)/, '');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`
    : last3;
  return `${sign}${grouped}${fraction}`;
}

/**
 * "a" or "an" before a word, by how it is said rather than how it is spelt where the two
 * disagree often enough to matter in a designation: "an Electrician", "an Engineer", "a Project
 * Manager", "a Unit Head", "an HR Executive", "an MIS Executive".
 */
export function indefiniteArticle(phrase: string): 'a' | 'an' {
  const word = phrase.trim().replace(/^[^A-Za-z0-9]+/, '');
  if (!word) return 'a';
  const first = word.split(/[\s-]/)[0];
  // An initialism is read letter by letter: "HR", "MIS", "QA/QC".
  if (/^[A-Z]{2,}/.test(first)) {
    return 'AEFHILMNORSX'.includes(first[0]) ? 'an' : 'a';
  }
  const lower = word.toLowerCase();
  if (/^(uni|use|usu|uti|eu|one\b|once)/.test(lower)) return 'a';
  if (/^(hour|honou?r|heir)/.test(lower)) return 'an';
  return /^[aeiou]/.test(lower) ? 'an' : 'a';
}

/**
 * The registered office on one line, its parts each once (2026-10-15).
 *
 * The company's `address` is often typed in full — "28A, Gandhi Nagar, …, Deoli, Tonk,
 * Rajasthan - 304804" — and the city, state and PIN code are held beside it as well. Joined
 * blindly, the F&F sheet's header read "…Rajasthan - 304804, Deoli, Rajasthan - 304804". A part
 * the address already contains is left out.
 */
export function composeAddress(parts: {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  pinCode?: string | null;
}): string {
  const address = parts.address?.trim() ?? '';
  const has = (part: string) =>
    new RegExp(`\\b${escapeRegExp(part)}\\b`, 'i').test(address);
  const extra = [parts.city, parts.state]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part && !has(part));
  const place = [address, ...extra].filter(Boolean).join(', ');
  const pin = parts.pinCode?.trim() ?? '';
  if (!pin || has(pin)) return place;
  return place ? `${place} - ${pin}` : pin;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The tick boxes for one choice — "[X] Bank Transfer (NEFT)  [ ] Cheque  [ ] Cash" — from what was
 * typed. Each option lists the words that select it; a typed value naming one is ticked, with the
 * typed detail kept in brackets where it says more than the option ("NEFT" under Bank Transfer).
 * Blank, or naming none of them, prints every box open — the form as printed, to tick by hand.
 */
export function tickBoxes(
  typed: string,
  options: { label: string; matches: RegExp }[],
): string {
  const value = typed.trim();
  const chosen = value ? options.find((o) => o.matches.test(value)) : undefined;
  const unmatched = value && !chosen ? `  (${value})` : '';
  return (
    options
      .map((option) => {
        if (option !== chosen) return `[ ] ${option.label}`;
        const bare = (text: string) =>
          text.toLowerCase().replace(/[^a-z0-9]/g, '');
        const detail = bare(value) === bare(option.label) ? '' : ` (${value})`;
        return `[X] ${option.label}${detail}`;
      })
      .join('  ') + unmatched
  );
}

const PAYMENT_MODES = [
  {
    label: 'Bank Transfer',
    matches: /\b(bank|neft|rtgs|imps|upi|transfer|online)\b/i,
  },
  { label: 'Cheque', matches: /\b(cheque|check|chq|dd|demand draft)\b/i },
  { label: 'Cash', matches: /\bcash\b/i },
];

// "Paid" refuses anything saying "part", which "Part-paid" is for.
const PAYMENT_STATUSES = [
  { label: 'Paid', matches: /^(?!.*\bpart).*\b(paid|done|complete)/i },
  { label: 'Part-paid', matches: /\bpart/i },
  { label: 'Pending', matches: /\b(pending|unpaid|due)\b/i },
];

/**
 * The money tokens of each kind: printed on the Indian grouping whatever was typed. Declared
 * here rather than guessed from the value, because a mobile number, a UAN and the last four
 * digits of an account are numbers too, and "1,00,98,76,54,321" is not anybody's UAN.
 */
export const MONEY_TOKENS: Readonly<Record<string, readonly string[]>> = {
  appointment: [
    'basicMonthly',
    'basicAnnual',
    'hraMonthly',
    'hraAnnual',
    'daMonthly',
    'daAnnual',
    'conveyanceMonthly',
    'conveyanceAnnual',
    'medicalMonthly',
    'medicalAnnual',
    'siteAllowanceMonthly',
    'siteAllowanceAnnual',
    'specialAllowanceMonthly',
    'specialAllowanceAnnual',
    'grossMonthly',
    'grossAnnual',
    'pfEmployerMonthly',
    'pfEmployerAnnual',
    'esicEmployerMonthly',
    'esicEmployerAnnual',
    'mealVoucherMonthly',
    'mealVoucherAnnual',
    'ctcMonthly',
    'ctcAnnual',
    'netTakeHomeMonthly',
    'netTakeHomeAnnual',
  ],
  increment: ['revisedCtcMonthly'],
  fnf_settlement: [
    'monthlyGross',
    'salaryPayable',
    'overtimeAmount',
    'leaveEncashment',
    'reimbursements',
    'bonus',
    'gratuity',
    'otherPayable',
    'totalPayable',
    'statutoryDeductions',
    'loanRecovery',
    'noticeRecovery',
    'assetRecovery',
    'otherDeductions',
    'totalDeductions',
    'netPayable',
  ],
  payment_advice: ['amount', 'paymentAmount', 'tdsAmount'],
};

/** The neutral forms the employee record falls back to when it holds no gender. */
const NEUTRAL = {
  relation: 'S/o / D/o',
  pronounObject: 'them',
  pronounPossessive: 'their',
  pronounSubject: 'they',
};

/** "Mr." → male, "Ms." / "Mrs." / "Miss" → female, anything else unknown. */
export function genderOfSalutation(
  salutation: string | null | undefined,
): 'male' | 'female' | null {
  const s = (salutation ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (s === 'mr' || s === 'shri' || s === 'sri') return 'male';
  if (
    s === 'ms' ||
    s === 'mrs' ||
    s === 'miss' ||
    s === 'smt' ||
    s === 'kumari'
  ) {
    return 'female';
  }
  return null;
}

/**
 * The values as the page prints them, for one kind (2026-10-15). Tokens the body uses but no
 * field declares are added here too — `designationArticle` — and listed in `SUPPLIED_TOKENS`.
 */
export function presentLetterValues(
  kindKey: string,
  variables: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...variables };

  for (const token of MONEY_TOKENS[kindKey] ?? []) {
    if (typeof out[token] === 'string') {
      out[token] = formatIndianAmount(out[token]);
    }
  }

  // A salutation that says who the letter is about decides the relation and the pronouns the
  // record left neutral — the record had no gender, HR typed "Mr." — rather than printing
  // "Mr. Rajesh Kulkarni S/o / D/o …" and "we found them". A value HR typed is never replaced:
  // only the record's neutral fallback is.
  const gender = genderOfSalutation(out.salutation);
  if (gender) {
    const forms =
      gender === 'male'
        ? {
            relation: 'S/o',
            pronounObject: 'him',
            pronounPossessive: 'his',
            pronounSubject: 'he',
          }
        : {
            relation: 'D/o',
            pronounObject: 'her',
            pronounPossessive: 'her',
            pronounSubject: 'she',
          };
    for (const key of Object.keys(NEUTRAL) as (keyof typeof NEUTRAL)[]) {
      if (
        (out[key] ?? '').trim().toLowerCase() === NEUTRAL[key].toLowerCase()
      ) {
        out[key] = forms[key];
      }
    }
  }

  if (kindKey === 'increment') {
    out.designationArticle = indefiniteArticle(out.designation ?? '');
  }

  // The body says "report to the {{reportingSite}} site on …", as the client's format does; a
  // site whose own name ends in "Site" printed "… Site site".
  if (kindKey === 'transfer' && typeof out.reportingSite === 'string') {
    out.reportingSite = out.reportingSite.replace(/\s+site\s*$/i, '');
  }

  // "‘Sr. Engineer-Highway’ (S3 Grade) at …": the grade is optional, and blank prints nothing —
  // not even the space before it. Typed as "S3", "S3 Grade" or "(S3 Grade)", it prints the same.
  if (kindKey === 'offer' && typeof out.grade === 'string') {
    const grade = out.grade
      .trim()
      .replace(/^\((.*)\)$/, '$1')
      .replace(/\s*grade$/i, '')
      .trim();
    out.grade = grade ? ` (${grade} Grade)` : '';
  }

  if (kindKey === 'fnf_settlement') {
    out.paymentMode = tickBoxes(out.paymentMode ?? '', PAYMENT_MODES);
    out.paymentStatus = tickBoxes(out.paymentStatus ?? '', PAYMENT_STATUSES);
  }

  return out;
}
