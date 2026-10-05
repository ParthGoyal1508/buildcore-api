-- RenameIndex
ALTER INDEX "hr"."ExitClearanceWaiverProposal_item_status_key" RENAME TO "ExitClearanceWaiverProposal_exitRecordId_itemKind_itemRef_s_key";

-- RenameIndex
ALTER INDEX "payroll"."BankSheetRecovery_run_advance_key" RENAME TO "BankSheetRecovery_payrollRunId_salaryAdvanceId_key";

-- RenameIndex
ALTER INDEX "payroll"."SlipDelivery_run_employee_key" RENAME TO "SlipDelivery_payrollRunId_employeeId_key";

-- RenameIndex
ALTER INDEX "payroll"."SlipDelivery_run_status_idx" RENAME TO "SlipDelivery_payrollRunId_status_idx";

-- RenameIndex
ALTER INDEX "projects"."ClientBill_project_number_key" RENAME TO "ClientBill_projectId_billNumber_key";

-- RenameIndex
ALTER INDEX "projects"."ClientBill_project_status_idx" RENAME TO "ClientBill_projectId_status_idx";

-- RenameIndex
ALTER INDEX "projects"."ClientBillLine_bill_item_key" RENAME TO "ClientBillLine_clientBillId_boqTaskItemId_key";

-- RenameIndex
ALTER INDEX "projects"."RABillLine_bill_item_key" RENAME TO "RABillLine_raBillId_workOrderBoqItemId_key";

-- RenameIndex
ALTER INDEX "settings"."LetterKindField_kind_token_key" RENAME TO "LetterKindField_letterKindId_token_key";

