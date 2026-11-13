// Shown when a screen needs something the Google Sheet's script does not have yet.

import { Button } from './ui';

export default function OutdatedBackend({ what, onRecheck }) {
  return (
    <div style={{
      padding: '11px 13px', margin: '10px 0', background: 'var(--danger-bg)',
      border: '1px solid #FECACA', borderRadius: 'var(--r-sm)', fontSize: 13, color: '#991B1B',
    }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>
        Your Google Sheet script is out of date — {what} will not work until you update it
      </div>
      <ol style={{ margin: '4px 0 8px', paddingLeft: 20, lineHeight: 1.6 }}>
        <li>Open your Google Sheet &rarr; <strong>Extensions &rarr; Apps Script</strong>.</li>
        <li>Replace everything in <strong>Code.gs</strong> with the latest <strong>apps-script/Code.gs</strong> and Save.</li>
        <li><strong>Deploy &rarr; Manage deployments &rarr; pencil (edit) &rarr; Version: New version &rarr; Deploy.</strong>{' '}
          Saving alone is not enough — the new version must be deployed.</li>
        <li>Come back and press <strong>Check again</strong>.</li>
      </ol>
      {onRecheck && <Button size="sm" onClick={onRecheck}>Check again</Button>}
    </div>
  );
}
