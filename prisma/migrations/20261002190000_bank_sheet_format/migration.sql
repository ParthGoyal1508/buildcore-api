-- 021 FR-008a to FR-008g: the bank transaction sheet takes the client's actual format.
-- `docs/RING ROAD JULY SALARY.xls`, received 2026-10-02, closed the last open question in 021.

-- The name the **beneficiary's own bank** holds against the account, which is not the employee's
-- name as HR spells it. In the sample these are misspelled against any HR record ("Arivnd",
-- "Rosan") because they match the bank. A transfer is matched on the account number, but a name
-- disagreeing with the bank's is what gets a payment returned — and the first anybody knows is on
-- payment day.
--
-- Nullable, with the export refusing a row where it is unset rather than substituting the
-- employee's name. The refusal happens while somebody can still fix it.
ALTER TABLE "hr"."Employee" ADD COLUMN "bankAccountHolderName" TEXT;

-- The company's own account the transfer is debited from. TEXT, because the sample's single value
-- is `09310400000819` and that leading zero is part of the account number.
ALTER TABLE "settings"."Company" ADD COLUMN "payrollDebitAccountNumber" TEXT;
