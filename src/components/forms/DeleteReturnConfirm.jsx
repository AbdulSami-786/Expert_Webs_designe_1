// Permanently delete one return entry. It says exactly what will change, because a return touches
// three things at once: what the bill is worth, the stock, and (when money was handed back) the till.

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import api from '../../lib/api';
import { Modal, Button } from '../ui';
import { money, fmtDate } from '../../lib/format';

export default function DeleteReturnConfirm({ returnId, onClose }) {
  const { data, mutate } = useApp();
  const [busy, setBusy] = useState(false);

  const ret = returnId ? data.returns.find((r) => r.id === returnId) : null;
  if (!ret) return null;

  const bill = data.bills.find((b) => b.id === ret.billId);
  const party = bill ? data.parties.find((p) => p.id === bill.partyId) : null;
  const item = data.items.find((i) => i.id === ret.itemId);
  const refunded = Number(ret.refundAmount) || 0;

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await mutate(() => api.deleteReturn(ret.id), 'Return deleted');
      onClose?.();
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  return (
    <Modal open title="Delete this return?" onClose={onClose}
           footer={(
             <>
               <Button onClick={onClose}>Cancel</Button>
               <Button variant="danger" icon={Trash2} onClick={submit} loading={busy}>Delete return</Button>
             </>
           )}>
      <p style={{ marginTop: 0, fontSize: 14, lineHeight: 1.6 }}>
        <strong>{ret.qty} × {item?.name || 'item'}</strong> ({money(ret.valueAdjusted)}), returned on {fmtDate(ret.date)}
        {bill ? <> against Bill <strong>{bill.billNo}</strong></> : null}
        {party ? <> ({party.name})</> : null}, will be removed permanently. This cannot be undone.
      </p>
      <ul style={{ margin: '0 0 4px', paddingLeft: 20, lineHeight: 1.7, fontSize: 13.5 }}>
        <li>The bill goes back up by <strong>{money(ret.valueAdjusted)}</strong>, so {party?.name || 'the party'} owes that much again.</li>
        {ret.restock && <li><strong>{ret.qty}</strong> of this item comes back out of your stock (it was added back when returned).</li>}
        {refunded > 0 && (
          <li>The <strong>{money(refunded)}</strong> refunded by {ret.refundMethod || 'Cash'} is put back into your {ret.refundMethod || 'Cash'} balance.</li>
        )}
      </ul>
    </Modal>
  );
}
