/**
 * Indian states and union territories with their two-digit GST state codes (041).
 *
 * A GSTIN's first two characters are the code of the state it is registered in, so a branch in
 * Gujarat must carry a `24…` GSTIN. The names match the `states` list the client data workbook
 * offers (scripts/make-client-data-templates.js), which is also how `Company.state` and
 * `CompanyBranch.state` are stored — a name, not a code.
 *
 * Codes are text: `08` is not 8.
 */
export const GST_STATE_CODES: Readonly<Record<string, string>> = {
  'Jammu and Kashmir': '01',
  'Himachal Pradesh': '02',
  Punjab: '03',
  Chandigarh: '04',
  Uttarakhand: '05',
  Haryana: '06',
  Delhi: '07',
  Rajasthan: '08',
  'Uttar Pradesh': '09',
  Bihar: '10',
  Sikkim: '11',
  'Arunachal Pradesh': '12',
  Nagaland: '13',
  Manipur: '14',
  Mizoram: '15',
  Tripura: '16',
  Meghalaya: '17',
  Assam: '18',
  'West Bengal': '19',
  Jharkhand: '20',
  Odisha: '21',
  Chhattisgarh: '22',
  'Madhya Pradesh': '23',
  Gujarat: '24',
  // 25 (Daman and Diu) was merged into 26 in 2020; new registrations use 26.
  'Dadra and Nagar Haveli and Daman and Diu': '26',
  Maharashtra: '27',
  Karnataka: '29',
  Goa: '30',
  Lakshadweep: '31',
  Kerala: '32',
  'Tamil Nadu': '33',
  Puducherry: '34',
  'Andaman and Nicobar Islands': '35',
  Telangana: '36',
  'Andhra Pradesh': '37',
  Ladakh: '38',
};

/**
 * The ROC state abbreviation a CIN carries in characters 7–8 (`U70109`**`RJ`**`2022…`), to the
 * state name. Used to tell which of a company's GST registrations is its registered office.
 */
export const CIN_STATE_TO_NAME: Readonly<Record<string, string>> = {
  AN: 'Andaman and Nicobar Islands',
  AP: 'Andhra Pradesh',
  AR: 'Arunachal Pradesh',
  AS: 'Assam',
  BR: 'Bihar',
  CH: 'Chandigarh',
  CT: 'Chhattisgarh',
  DL: 'Delhi',
  DN: 'Dadra and Nagar Haveli and Daman and Diu',
  DD: 'Dadra and Nagar Haveli and Daman and Diu',
  GA: 'Goa',
  GJ: 'Gujarat',
  HP: 'Himachal Pradesh',
  HR: 'Haryana',
  JH: 'Jharkhand',
  JK: 'Jammu and Kashmir',
  KA: 'Karnataka',
  KL: 'Kerala',
  LA: 'Ladakh',
  LD: 'Lakshadweep',
  MH: 'Maharashtra',
  ML: 'Meghalaya',
  MN: 'Manipur',
  MP: 'Madhya Pradesh',
  MZ: 'Mizoram',
  NL: 'Nagaland',
  OR: 'Odisha',
  PB: 'Punjab',
  PY: 'Puducherry',
  RJ: 'Rajasthan',
  SK: 'Sikkim',
  TG: 'Telangana',
  TN: 'Tamil Nadu',
  TR: 'Tripura',
  UP: 'Uttar Pradesh',
  UR: 'Uttarakhand',
  UT: 'Uttarakhand',
  WB: 'West Bengal',
};

const BY_LOWER_NAME = new Map(
  Object.entries(GST_STATE_CODES).map(([name, code]) => [
    name.toLowerCase(),
    { name, code },
  ]),
);

/** The canonical spelling of a state name, matched ignoring case and spacing; null if unknown. */
export function canonicalStateName(state?: string | null): string | null {
  if (!state) return null;
  return (
    BY_LOWER_NAME.get(state.trim().replace(/\s+/g, ' ').toLowerCase())?.name ??
    null
  );
}

/** `Rajasthan` (any case) → `08`; null for an unknown or empty name. */
export function gstStateCodeFor(state?: string | null): string | null {
  const name = canonicalStateName(state);
  return name ? GST_STATE_CODES[name] : null;
}

/** `08` → `Rajasthan`; null for an unknown code. */
export function stateNameForCode(code?: string | null): string | null {
  if (!code) return null;
  return (
    Object.keys(GST_STATE_CODES).find((n) => GST_STATE_CODES[n] === code) ??
    null
  );
}

/** The state a CIN was registered in — `U70109RJ2022PTC081146` → `Rajasthan`; null if unreadable. */
export function cinStateName(cin?: string | null): string | null {
  const abbr = cin?.trim().toUpperCase().slice(6, 8);
  return abbr ? CIN_STATE_TO_NAME[abbr] ?? null : null;
}
