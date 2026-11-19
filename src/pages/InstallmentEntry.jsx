// Installment Entry — the ledger of bills sold on an instalment plan.
// These are kept out of the Ledger Book; same layout, filtered to instalment bills only.

import LedgerBook from './LedgerBook';

export default function InstallmentEntry() {
  return <LedgerBook mode="installment" />;
}
