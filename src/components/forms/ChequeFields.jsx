// The details of one cheque, shared by every form that can take a payment by
// cheque: a bill's payment, the party ledger's account payment, and the
// payments entered while writing a bill.

import { Info } from 'lucide-react';
import { Input } from '../ui';
import { addDays } from '../../lib/format';

/** A blank cheque, clearing a week after `date` unless changed. */
export function blankCheque(date) {
  return { accountHolder: '', chequeNo: '', bankName: '', dateIssued: date, dateDue: addDays(date, 7) };
}

export default function ChequeFields({ value, onChange }) {
  if (!value) return null;
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
      padding: 11, background: 'var(--surface-2, #FCFCFD)', marginTop: 8,
    }}>
      <div className="row" style={{ gap: 7, marginBottom: 7 }}>
        <Input placeholder="Account holder name" aria-label="Account holder name"
               value={value.accountHolder || ''} onChange={set('accountHolder')} />
      </div>
      <div className="row" style={{ gap: 7, marginBottom: 7 }}>
        <Input placeholder="Cheque number" aria-label="Cheque number"
               value={value.chequeNo || ''} onChange={set('chequeNo')} />
        <Input placeholder="Bank name" aria-label="Bank name"
               value={value.bankName || ''} onChange={set('bankName')} />
      </div>
      <div className="row" style={{ gap: 7 }}>
        <div style={{ flex: 1 }}>
          <label className="small muted">Issued</label>
          <Input type="date" value={value.dateIssued || ''} onChange={set('dateIssued')} />
        </div>
        <div style={{ flex: 1 }}>
          <label className="small muted">Clears on</label>
          <Input type="date" value={value.dateDue || ''} onChange={set('dateDue')} />
        </div>
      </div>
      <div className="small muted mt-1">
        <Info size={11} style={{ verticalAlign: -1 }} /> Not counted as paid until you mark it Cleared.
      </div>
    </div>
  );
}
