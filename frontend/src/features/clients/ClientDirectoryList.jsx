import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, History, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/**
 * Client Directory list, paginated.
 *  - Enough room (the list itself is 860px or wider): a table (Role, Name, Email, Number, Joined, Actions).
 *  - Phones, and tablets where the sidebar leaves too little room: the same rows as cards, also paginated.
 * The choice follows the list's own width, not the window, so it is right with or without the sidebar.
 * Built on the shadcn table + theme tokens (ui-root), so it follows light/dark mode.
 */
const ROLE_LABEL = { CUSTOMER: 'Customer', STAFF: 'Staff', ADMIN: 'Admin' };
const phoneOf = (u) => u.phone_number || u.phone || u.contact_number || '';

function Pager({ page, pages, total, from, to, setPage }) {
  if (total === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-sm text-muted-foreground">
      <span>{from}–{to} of {total}</span>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="icon" className="size-9" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Previous page">
          <ChevronLeft />
        </Button>
        <span className="min-w-[5.5rem] text-center">Page {page + 1} of {pages}</span>
        <Button variant="outline" size="icon" className="size-9" disabled={page >= pages - 1} onClick={() => setPage(page + 1)} aria-label="Next page">
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

function Actions({ user, canDelete, onHistory, onDelete, full = false }) {
  return (
    <div className={full ? 'grid grid-cols-2 gap-2' : 'flex justify-center gap-1.5'}>
      <Button size="sm" variant="outline" onClick={() => onHistory(user)} className={full ? 'h-10' : undefined}>
        <History /> View history
      </Button>
      {canDelete(user) ? (
        <Button size="sm" variant="outline" className={`text-destructive ${full ? 'h-10' : ''}`} onClick={() => onDelete(user)}>
          <Trash2 /> Delete account
        </Button>
      ) : full ? <span /> : null}
    </div>
  );
}

export default function ClientDirectoryList({ users, loading, isMobile: phone = false, searchKey, formatDate, canDelete, onHistory, onDelete }) {
  const boxRef = useRef(null);
  const [narrow, setNarrow] = useState(phone);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 860));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const isMobile = phone || narrow;
  const perPage = 10;
  const [page, setPage] = useState(0);
  const total = users.length;
  const pages = Math.max(1, Math.ceil(total / perPage));

  // Back to page 1 when the search or the page size changes; never sit past the last page.
  useEffect(() => { setPage(0); }, [searchKey, perPage]);
  useEffect(() => { if (page > pages - 1) setPage(pages - 1); }, [page, pages]);

  const start = page * perPage;
  const rows = users.slice(start, start + perPage);
  const pager = <Pager page={page} pages={pages} total={total} from={start + 1} to={Math.min(total, start + perPage)} setPage={setPage} />;

  let body;
  if (loading) {
    body = (
      <div className="ui-root rounded-lg border p-6 text-center text-sm text-muted-foreground">Loading clients…</div>
    );
  } else if (total === 0) {
    body = (
      <div className="ui-root rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">No matching clients found.</div>
    );
  } else if (isMobile) {
    body = (
      <div className="ui-root overflow-hidden rounded-lg border">
        <ul className="m-0 grid list-none gap-0 p-0">
          {rows.map((user) => (
            <li key={user.id} className="grid gap-2 border-b px-3 py-3 last:border-b-0">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium [overflow-wrap:anywhere]">{user.full_name || 'Unnamed client'}</div>
                  <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{user.email || '—'}</div>
                </div>
                <span className="shrink-0 rounded-[2px] border px-1.5 py-0.5 text-xs text-muted-foreground">{ROLE_LABEL[user.role] || user.role}</span>
              </div>
              <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                <dt className="text-muted-foreground">Number</dt><dd className="m-0">{phoneOf(user) || '—'}</dd>
                <dt className="text-muted-foreground">Joined</dt><dd className="m-0">{formatDate(user.created_at)}</dd>
              </dl>
              <Actions user={user} canDelete={canDelete} onHistory={onHistory} onDelete={onDelete} full />
            </li>
          ))}
        </ul>
        {pager}
      </div>
    );
  } else {
    body = (
    <div className="ui-root overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Role</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Number</TableHead>
            <TableHead>Joined</TableHead>
            <TableHead className="pr-4 text-center">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((user) => (
            <TableRow key={user.id}>
              <TableCell className="pl-4 text-muted-foreground">{ROLE_LABEL[user.role] || user.role}</TableCell>
              <TableCell className="max-w-[14rem] font-medium whitespace-normal [overflow-wrap:anywhere]">{user.full_name || 'Unnamed client'}</TableCell>
              <TableCell className="max-w-[16rem] whitespace-normal [overflow-wrap:anywhere]">{user.email || '—'}</TableCell>
              <TableCell className="whitespace-nowrap">{phoneOf(user) || '—'}</TableCell>
              <TableCell className="whitespace-nowrap">{formatDate(user.created_at)}</TableCell>
              <TableCell className="pr-4"><Actions user={user} canDelete={canDelete} onHistory={onHistory} onDelete={onDelete} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {pager}
    </div>
    );
  }

  return <div ref={boxRef} className="w-full min-w-0">{body}</div>;
}
