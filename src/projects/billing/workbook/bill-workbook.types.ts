/**
 * **The only thing the renderer can see** (023 FR-028, research §6).
 *
 * Every figure here is a string, already computed and already rounded. The renderer holds no Prisma
 * client, takes no rate, and performs no arithmetic — so "every figure in the workbook comes from
 * the stored bill and none is recomputed at production time" is a property of what the renderer
 * *can* reach rather than a rule somebody has to remember. A renderer that could query could
 * recompute, and a bill produced twice must be identical to the one the client signed.
 *
 * That is also why these are strings and not `Decimal`s. A `Decimal` in here would be an invitation
 * to add two of them.
 */

/** Which party sits in which slot (FR-025). */
export interface WorkbookParty {
  /** Null where the party's record does not carry it. Printed blank, never refused (FR-027). */
  name: string | null;
  gstin: string | null;
  pan: string | null;
  state: string | null;
  address: string | null;
  /** The vendor's own code, on a bill to a subcontractor. */
  code: string | null;
}

/** The header block every sheet repeats. */
export interface WorkbookHeader {
  /**
   * The party in the **"Company Name"** slot — the company on a bill to a subcontractor, the
   * authority on a bill to a client. FR-025's two bindings are this field and the next.
   */
  issuer: WorkbookParty;
  /** The party in the **"Name of Sub-Contractor"** slot. */
  receiver: WorkbookParty;
  projectName: string;
  natureOfWork: string | null;
  location: string | null;
  externalWorkOrderNo: string | null;
  externalBillNo: string | null;
  /** "RA-12". One rendering, on every sheet, from one source. */
  billLabel: string;
  periodFrom: string;
  periodTo: string;
  billDate: string;
  /** What could not be filled (FR-027). Reported on the workbook, never a refusal. */
  missingFields: string[];
}

export interface WorkbookCheckListRow {
  position: number;
  text: string;
  /** `yes`, `no`, `not_required`, or null for unanswered — which is not an answer of no (FR-042). */
  answer: string | null;
}

export interface WorkbookCheckList {
  rows: WorkbookCheckListRow[];
  footer: string;
  signatories: readonly string[];
}

/** One row of the abstract: a label and its three columns, already rendered (FR-012a). */
export interface WorkbookAbstractRow {
  label: string;
  uptoDate: string;
  uptoPrevious: string;
  thisMonth: string;
  /** True for a block total, which the sheet emphasises. */
  isTotal?: boolean;
  /**
   * True where this row is blank **this month** because it is fully recovered (FR-020a).
   *
   * Carried rather than inferred from a zero: "nothing was recovered this month" and "there is
   * nothing left to recover" print the same character and are different facts.
   */
  fullyRecovered?: boolean;
}

export interface WorkbookAbstract {
  blocks: { title: string; rows: WorkbookAbstractRow[] }[];
  payable: WorkbookAbstractRow;
  netPayable: WorkbookAbstractRow;
  /** Which tax applied and how that was decided, printed so a reviewer can check it (FR-016a). */
  taxBasis: string;
  taxBasisSource: string;
}

export interface WorkbookScheduleLine {
  srNo: number;
  boqNo: string;
  /** Carried whole, however long (FR-029). */
  description: string;
  unit: string;
  scopeQty: string;
  rate: string;
  scopeAmount: string;
  /** Negative where measurement has passed scope (FR-012b). */
  balanceQty: string;
  qtyUptoDate: string;
  qtyUptoPrevious: string;
  qtyThisBill: string;
  amountUptoDate: string;
  amountUptoPrevious: string;
  amountThisBill: string;
}

export interface WorkbookSchedule {
  lines: WorkbookScheduleLine[];
  totals: {
    scopeAmount: string;
    amountUptoDate: string;
    amountUptoPrevious: string;
    amountThisBill: string;
  };
}

export interface WorkbookMeasurementSheet {
  /** The schedule line this sheet belongs to. Printed **inside** the sheet (FR-024a). */
  scheduleLineId: string;
  srNo: number;
  boqNo: string;
  description: string;
  unit: string;
  history: {
    month: string;
    period: string;
    quantity: string;
    remarks: string | null;
    billLabel: string;
    overClaimed: boolean;
  }[];
  dailyRecord: {
    date: string;
    openingReading: string | null;
    closingReading: string | null;
    totalRun: string | null;
    remarks: string | null;
    /** Printed as "no record", not as zero (FR-034). */
    missing: boolean;
  }[];
  footer: {
    thisBillQty: string;
    uptoPreviousQty: string;
    uptoDateQty: string;
  };
}

export interface WorkbookDebitRegister {
  groups: {
    heading: string | null;
    rows: {
      srNo: number;
      description: string;
      location: string | null;
      nos: string | null;
      length: string | null;
      width: string | null;
      quantity: string | null;
      rate: string;
      unit: string | null;
      amount: string;
      amountWithTax: string;
      /** Which bill it was debited in — "RA-02", "RA-07" (FR-039). */
      remark: string | null;
    }[];
  }[];
  total: string;
}

/** The whole package, as the renderer receives it. */
export interface BillWorkbookView {
  header: WorkbookHeader;
  checkList: WorkbookCheckList;
  abstract: WorkbookAbstract;
  schedule: WorkbookSchedule;
  /** **One per schedule line, including lines with nothing claimed** (FR-030, FR-030a). */
  measurementSheets: WorkbookMeasurementSheet[];
  debitRegister: WorkbookDebitRegister;
}
