import { useCallback, useEffect, useState } from 'react';
import { DatabaseBackup, Download, RotateCcw, Trash2 } from 'lucide-react';
import toast from '@/lib/toast';
import { BACKEND_URL, authHeaders } from '@/config/api';
import PageHeader from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ADMIN_TOURS } from '@/features/tours/adminTours';

/** System & Admin › Backups: monthly and on-demand copies of all the shop's data, kept 3 months. */

const TRIGGER = { SCHEDULED: 'Monthly', MANUAL: 'Manual', SAFETY: 'Before a restore' };
const fmt = (v) => new Date(v).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const day = (v) => new Date(v).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
const size = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

const api = async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(`${BACKEND_URL}/api/admin/backups${path}`, { method, headers: await authHeaders(), body: body && JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) throw new Error(json.error || 'Something went wrong. Please try again.');
  return json;
};

export default function BackupsPage() {
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(null); // 'create' | `${action}:${id}`
  const [restoring, setRestoring] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [typed, setTyped] = useState('');

  const load = useCallback(async () => {
    try { setList((await api('')).backups); } catch (err) { toast.error(err.message, { id: 'backups-load' }); setList([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (key, fn, done) => {
    setBusy(key);
    try { const r = await fn(); if (done) toast.success(done(r)); await load(); } catch (err) { toast.error(err.message); } finally { setBusy(null); }
  };
  const create = () => run('create', () => api('', { method: 'POST' }), () => 'Backup made.');
  const download = (b) => run(`dl:${b.id}`, async () => { const { url } = await api(`/${b.id}/download`); window.location.assign(url); });
  const restore = () => {
    const b = restoring; setRestoring(null); setTyped('');
    run(`rs:${b.id}`, () => api(`/${b.id}/restore`, { method: 'POST', body: { confirm: 'RESTORE' } }),
      () => `Data restored from the ${day(b.created_at)} backup. A safety backup of the data before the restore was saved.`);
  };
  const remove = () => { const b = deleting; setDeleting(null); run(`rm:${b.id}`, () => api(`/${b.id}`, { method: 'DELETE' }), () => 'Backup deleted.'); };

  const actions = (b) => (
    <div className="flex flex-wrap justify-end gap-2">
      <Button size="sm" variant="outline" disabled={!!busy} onClick={() => download(b)}><Download aria-hidden="true" /> Download</Button>
      <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setRestoring(b)}><RotateCcw aria-hidden="true" /> {busy === `rs:${b.id}` ? 'Restoring…' : 'Restore'}</Button>
      <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setDeleting(b)} aria-label={`Delete backup from ${fmt(b.created_at)}`}><Trash2 aria-hidden="true" /></Button>
    </div>
  );

  return (
    <div className="ui-root @container flex flex-col gap-6 pb-16">
      <PageHeader
        title="Backups"
        subtitle="A full copy of the shop's data is saved on the 1st of every month and kept for 3 months (6 at most; the oldest goes first). Make one any time with Back up now."
        tour={ADMIN_TOURS.backups}
      />

      <Card className="flex-row flex-wrap items-center justify-between gap-4 rounded-md p-4" data-tour="bk-create">
        <div className="min-w-0 max-w-prose text-sm text-muted-foreground">
          Each backup has every booking, payment, receipt record, chat, setting and account detail, plus a spreadsheet (CSV) of each part.
          Photos and uploaded images are not included. Download a copy now and then to keep one off the system.
        </div>
        <Button onClick={create} disabled={!!busy}><DatabaseBackup aria-hidden="true" /> {busy === 'create' ? 'Backing up…' : 'Back up now'}</Button>
      </Card>

      <div data-tour="bk-list">
        {list === null ? (
          <div className="grid gap-2" aria-busy="true"><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
        ) : !list.length ? (
          <Card className="items-center rounded-md p-10 text-center text-sm font-semibold">No backups yet. Press Back up now to make the first one.</Card>
        ) : (
          <>
            <Card className="hidden gap-0 overflow-hidden rounded-md p-0 @3xl:flex">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead className="px-4">Made</TableHead>
                    <TableHead className="px-4">Type</TableHead>
                    <TableHead className="px-4 text-right">Records</TableHead>
                    <TableHead className="px-4 text-right">Size</TableHead>
                    <TableHead className="px-4">Removed on</TableHead>
                    <TableHead className="px-4"><span className="sr-only">Actions</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((b) => (
                    <TableRow key={b.id}>
                      <TableCell className="px-4"><p className="font-semibold">{fmt(b.created_at)}</p><p className="font-mono text-xs text-muted-foreground" translate="no">{b.file_path}</p></TableCell>
                      <TableCell className="px-4 text-sm">{TRIGGER[b.trigger]}</TableCell>
                      <TableCell className="px-4 text-right tabular-nums">{b.row_count.toLocaleString()}</TableCell>
                      <TableCell className="px-4 text-right tabular-nums">{size(b.size_bytes)}</TableCell>
                      <TableCell className="px-4 text-sm text-muted-foreground">{day(b.expires_at)}</TableCell>
                      <TableCell className="px-4">{actions(b)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
            <div className="grid gap-3 @3xl:hidden">
              {list.map((b) => (
                <Card key={b.id} className="gap-2 rounded-md p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-semibold">{fmt(b.created_at)}</p>
                    <p className="text-sm text-muted-foreground">{TRIGGER[b.trigger]}</p>
                  </div>
                  <p className="text-xs text-muted-foreground">{b.row_count.toLocaleString()} records · {size(b.size_bytes)} · removed on {day(b.expires_at)}</p>
                  {actions(b)}
                </Card>
              ))}
            </div>
          </>
        )}
      </div>

      <AlertDialog open={!!restoring} onOpenChange={(o) => { if (!o) { setRestoring(null); setTyped(''); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore the {restoring && fmt(restoring.created_at)} backup?</AlertDialogTitle>
            <AlertDialogDescription>
              All bookings, payments, chats and settings go back to how they were then. Anything added after it will be replaced.
              A backup of the current data is saved first, so this can be undone by restoring that one. Accounts and passwords are not removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="grid gap-1.5 text-sm">
            Type <b translate="no">RESTORE</b> to confirm
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" data-no-auto-capitalize="" autoCapitalize="characters" />
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={typed !== 'RESTORE'} onClick={restore}>Restore</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleting} onOpenChange={(o) => { if (!o) setDeleting(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this backup?</AlertDialogTitle>
            <AlertDialogDescription>The {deleting && fmt(deleting.created_at)} backup will be gone for good. Your current data is not affected.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={remove}>Delete</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
