// User Management — super admin only.
//
// Add users, choose which pages each one may open, reset passwords,
// deactivate (blocks sign-in without losing the account) and delete.
// The route is guarded in Shell, and every action is checked again by the
// backend (apps-script/Code.gs, src/lib/localAdapter.js).

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus, Pencil, KeyRound, Power, Trash2, ShieldCheck, UserRound, Save, Eye, EyeOff,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import api from '../lib/api';
import {
  Card, Button, Modal, Confirm, Empty, PageHead, SearchBar, Pill, Field, Input, Select, Skeleton,
} from '../components/ui';
import { PAGE_GROUPS, ALL_PAGE_KEYS } from '../lib/access';
import { fmtDate, norm } from '../lib/format';

export default function Users() {
  const { me, mutate, toast } = useApp();
  const [users, setUsers] = useState(null);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null);    // user | 'new' | null
  const [pwFor, setPwFor] = useState(null);
  const [toggling, setToggling] = useState(null);  // user to (de)activate
  const [deleting, setDeleting] = useState(null);

  const load = useCallback(async () => {
    try { setUsers(await api.listUsers()); }
    catch (e) { toast(e.message || 'Could not load users', 'error'); setUsers([]); }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    const term = norm(q);
    return (users || [])
      .filter((u) => !term || norm(u.username).includes(term) || norm(u.fullName).includes(term))
      .sort((a, b) => (a.role === 'admin' ? 0 : 1) - (b.role === 'admin' ? 0 : 1)
        || a.username.localeCompare(b.username));
  }, [users, q]);

  const isMe = (u) => String(u.username).toLowerCase() === String(me?.username).toLowerCase();

  const toggleStatus = async () => {
    const u = toggling;
    try {
      await mutate(() => api.setUserStatus(u.id, u.status === 'active' ? 'inactive' : 'active'),
        u.status === 'active' ? 'User deactivated' : 'User activated');
      setToggling(null);
      load();
    } catch { setToggling(null); }
  };

  const doDelete = async () => {
    const u = deleting;
    try {
      await mutate(() => api.deleteUser(u.id), 'User deleted');
      setDeleting(null);
      load();
    } catch { setDeleting(null); }
  };

  const pagesLabel = (u) => (u.role === 'admin'
    ? 'All pages'
    : `${u.allowedPages.length} of ${ALL_PAGE_KEYS.length} pages`);

  const actionButtons = (u) => (
    <>
      <button className="btn btn-ghost btn-sm" title="Edit user & page access" onClick={() => setEditing(u)}>
        <Pencil size={14} />
      </button>
      <button className="btn btn-ghost btn-sm" title="Change password" onClick={() => setPwFor(u)}>
        <KeyRound size={14} />
      </button>
      {!isMe(u) && (
        <>
          <button className="btn btn-ghost btn-sm"
                  title={u.status === 'active' ? 'Deactivate' : 'Activate'}
                  onClick={() => setToggling(u)}>
            <Power size={14} />
          </button>
          <button className="btn btn-ghost btn-sm" title="Delete user" onClick={() => setDeleting(u)}>
            <Trash2 size={14} color="var(--danger)" />
          </button>
        </>
      )}
    </>
  );

  return (
    <>
      <PageHead title="User Management"
                subtitle={users ? `${users.length} ${users.length === 1 ? 'user' : 'users'} · super admin only` : ''}>
        <SearchBar value={q} onChange={setQ} placeholder="Search name or username…" />
        <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>Add User</Button>
      </PageHead>

      <Card tight>
        {users === null ? <Skeleton rows={4} /> : !rows.length ? (
          <Empty icon={UserRound} title={q ? 'No matching users' : 'No users yet'}
                 message={q ? `Nothing matches "${q}".` : 'Add a user and choose which pages they can open.'} />
        ) : (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>User</th><th>Username</th><th>Role</th><th>Page access</th>
                    <th>Status</th><th>Created</th><th style={{ width: 150 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u) => (
                    <tr key={u.id} style={u.status === 'inactive' ? { opacity: .6 } : undefined}>
                      <td style={{ fontWeight: 600 }}>
                        {u.fullName || <span className="muted">—</span>}
                        {isMe(u) && <span className="pill pill-neutral" style={{ marginLeft: 8 }}>You</span>}
                      </td>
                      <td>{u.username}</td>
                      <td>
                        {u.role === 'admin'
                          ? <Pill status="pending" label="Super Admin" />
                          : <Pill status="neutral" label="User" />}
                      </td>
                      <td className="small">{pagesLabel(u)}</td>
                      <td>
                        <Pill status={u.status === 'active' ? 'paid' : 'voided'}
                              label={u.status === 'active' ? 'Active' : 'Inactive'} />
                      </td>
                      <td className="small nowrap">{u.createdAt ? fmtDate(u.createdAt.slice(0, 10)) : '—'}</td>
                      <td><div className="row-actions">{actionButtons(u)}</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mcards" style={{ padding: 12 }}>
              {rows.map((u) => (
                <div key={u.id} className="mcard" style={u.status === 'inactive' ? { opacity: .65 } : undefined}>
                  <div className="top">
                    <span className="name">{u.fullName || u.username}{isMe(u) && ' (you)'}</span>
                    <Pill status={u.status === 'active' ? 'paid' : 'voided'}
                          label={u.status === 'active' ? 'Active' : 'Inactive'} />
                  </div>
                  <div className="meta">
                    <span>@{u.username}</span>
                    <span>{u.role === 'admin' ? 'Super Admin' : 'User'}</span>
                    <span>{pagesLabel(u)}</span>
                  </div>
                  <div className="row-actions" style={{ opacity: 1, justifyContent: 'flex-start', marginTop: 8 }}>
                    {actionButtons(u)}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      <Modal open={Boolean(editing)} wide
             title={editing === 'new' ? 'Add User' : `Edit ${editing?.username || 'User'}`}
             onClose={() => setEditing(null)}>
        {editing && (
          <UserForm user={editing === 'new' ? null : editing} isSelf={editing !== 'new' && isMe(editing)}
                    onSaved={() => { setEditing(null); load(); }} onCancel={() => setEditing(null)} />
        )}
      </Modal>

      <Modal open={Boolean(pwFor)} title={`Change password — ${pwFor?.username || ''}`} onClose={() => setPwFor(null)}>
        {pwFor && <PasswordForm user={pwFor} onDone={() => setPwFor(null)} />}
      </Modal>

      <Confirm open={Boolean(toggling)}
               title={toggling?.status === 'active' ? 'Deactivate this user?' : 'Activate this user?'}
               message={toggling?.status === 'active'
                 ? `${toggling?.username} will be signed out and will not be able to sign in until you activate the account again. Nothing is deleted.`
                 : `${toggling?.username} will be able to sign in again.`}
               confirmLabel={toggling?.status === 'active' ? 'Deactivate' : 'Activate'}
               danger={toggling?.status === 'active'}
               onConfirm={toggleStatus} onCancel={() => setToggling(null)} />

      <Confirm open={Boolean(deleting)} title="Delete this user?" danger confirmLabel="Delete user"
               message={`"${deleting?.username}" will be permanently removed and can no longer sign in. Bills and records they created stay in the activity log. To keep the account but block sign-in, use Deactivate instead.`}
               onConfirm={doDelete} onCancel={() => setDeleting(null)} />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Add / edit user, with page access                                          */
/* -------------------------------------------------------------------------- */

function UserForm({ user, isSelf, onSaved, onCancel }) {
  const { mutate } = useApp();
  const [f, setF] = useState({
    fullName: user?.fullName || '',
    username: user?.username || '',
    password: '',
    role: user?.role || 'user',
    allowedPages: user?.allowedPages || [],
  });
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const picked = new Set(f.allowedPages);

  const toggle = (key) => setF((x) => {
    const s = new Set(x.allowedPages);
    s.has(key) ? s.delete(key) : s.add(key);
    return { ...x, allowedPages: [...s] };
  });
  const toggleGroup = (g) => setF((x) => {
    const s = new Set(x.allowedPages);
    const all = g.pages.every((p) => s.has(p.key));
    g.pages.forEach((p) => (all ? s.delete(p.key) : s.add(p.key)));
    return { ...x, allowedPages: [...s] };
  });
  const setAll = (on) => setF((x) => ({ ...x, allowedPages: on ? [...ALL_PAGE_KEYS] : [] }));

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!/^[A-Za-z0-9._-]{3,30}$/.test(f.username.trim())) {
      return setErr('Username must be 3–30 characters: letters, numbers, dot, dash or underscore.');
    }
    if (!user && f.password.length < 6) return setErr('Set a password of at least 6 characters.');
    if (f.role === 'user' && !f.allowedPages.length) {
      return setErr('Tick at least one page this user may open.');
    }
    setErr('');
    setBusy(true);
    try {
      await mutate(() => api.saveUser({
        id: user?.id, fullName: f.fullName.trim(), username: f.username.trim(),
        password: f.password, role: f.role,
        allowedPages: f.role === 'admin' ? [] : f.allowedPages,
      }), user ? 'User updated' : 'User added');
      onSaved();
    } catch (ex) { setErr(ex.message || 'Could not save user'); } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit}>
      <div className="form-grid">
        <Field label="Full name">
          <Input value={f.fullName} onChange={set('fullName')} autoFocus placeholder="e.g. Ahmed Raza" />
        </Field>
        <Field label="Username" hint="Used to sign in">
          <Input value={f.username} onChange={set('username')} autoComplete="off" placeholder="e.g. ahmed"
                 disabled={isSelf} title={isSelf ? 'You cannot change your own username' : undefined} />
        </Field>

        {!user && (
          <Field label="Password" hint="At least 6 characters">
            <div style={{ position: 'relative' }}>
              <Input type={show ? 'text' : 'password'} value={f.password} onChange={set('password')}
                     autoComplete="new-password" style={{ paddingRight: 38 }} />
              <button type="button" className="btn btn-ghost btn-sm" tabIndex={-1}
                      style={{ position: 'absolute', right: 2, top: 2 }}
                      onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'}>
                {show ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </Field>
        )}

        <Field label="Role" hint={f.role === 'admin' ? 'Opens every page and manages users' : 'Opens only the pages ticked below'}>
          <Select value={f.role} onChange={set('role')} disabled={isSelf}>
            <option value="user">User — selected pages only</option>
            <option value="admin">Super Admin — everything</option>
          </Select>
        </Field>
      </div>

      {f.role === 'user' ? (
        <div style={{ marginTop: 6 }}>
          <div className="row" style={{ justifyContent: 'space-between', margin: '4px 0 8px' }}>
            <div style={{ fontWeight: 600 }}>
              Page access <span className="muted small">· {f.allowedPages.length} of {ALL_PAGE_KEYS.length} selected</span>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <Button type="button" size="sm" onClick={() => setAll(true)}>Select all</Button>
              <Button type="button" size="sm" onClick={() => setAll(false)}>Clear</Button>
            </div>
          </div>
          <div className="perm-grid">
            {PAGE_GROUPS.map((g) => {
              const all = g.pages.every((p) => picked.has(p.key));
              return (
                <div key={g.label} className="perm-group">
                  <label className="perm-head">
                    <input type="checkbox" checked={all} onChange={() => toggleGroup(g)} />
                    {g.label}
                  </label>
                  {g.pages.map((p) => (
                    <label key={p.key} className="perm-item">
                      <input type="checkbox" checked={picked.has(p.key)} onChange={() => toggle(p.key)} />
                      {p.label}
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="small muted" style={{ display: 'flex', gap: 8, padding: '10px 0' }}>
          <ShieldCheck size={15} style={{ flex: 'none', marginTop: 1 }} />
          Super admins can open every page, including User Management.
        </div>
      )}

      {err && <div className="err" style={{ margin: '10px 0 0' }}>{err}</div>}

      <div className="row" style={{ justifyContent: 'flex-end', gap: 9, marginTop: 14 }}>
        <Button type="button" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" icon={Save} loading={busy}>
          {user ? 'Save Changes' : 'Create User'}
        </Button>
      </div>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Reset password                                                             */
/* -------------------------------------------------------------------------- */

function PasswordForm({ user, onDone }) {
  const { mutate } = useApp();
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (pw.length < 6) return setErr('Password must be at least 6 characters');
    if (pw !== confirm) return setErr('The two passwords do not match');
    setErr('');
    setBusy(true);
    try {
      await mutate(() => api.setUserPassword(user.id, pw), `Password updated for ${user.username}`);
      onDone();
    } catch (ex) { setErr(ex.message || 'Could not change password'); } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit}>
      <Field label="New password" hint="At least 6 characters. Tell the user their new password yourself.">
        <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)}
               autoComplete="new-password" autoFocus />
      </Field>
      <Field label="Confirm new password" error={err}>
        <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
               autoComplete="new-password" />
      </Field>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        <Button type="button" onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" icon={KeyRound} loading={busy}>Update Password</Button>
      </div>
    </form>
  );
}
