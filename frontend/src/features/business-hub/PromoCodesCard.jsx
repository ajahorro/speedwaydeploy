import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from '@/lib/toast';
import { Archive, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/lib/supabase';
import { useConfig } from '@/context/ConfigContext';
import { writeAdminAuditLog } from '@/services/auditLogService';
import { formatPeso } from '@/features/finance/money';
import { useConfirmAction } from '@/hooks/useConfirmAction';

const EMPTY = { code: '', name: '', discount_type: 'percentage', discount_value: '', vehicle_types: [], valid_from: '', valid_until: '', max_uses: '' };

const toIso = (local) => (local ? new Date(local).toISOString() : null);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

const statusOf = (row, now = Date.now()) => {
  if (!row.is_active) return { label: 'Archived', variant: 'outline' };
  if (row.valid_from && new Date(row.valid_from).getTime() > now) return { label: 'Scheduled', variant: 'secondary' };
  if (row.valid_until && new Date(row.valid_until).getTime() < now) return { label: 'Expired', variant: 'outline' };
  if (row.max_uses && row.uses_count >= row.max_uses) return { label: 'Used up', variant: 'outline' };
  return { label: 'Active', variant: 'default' };
};

/**
 * Business Hub › Promos › Promo codes. Codes live in the admin-only promo_codes table; the
 * customer redeems one on the last booking page through redeem_promo_code(). A code is never deleted: a current
 * code can only be archived (it stops working at once and moves to the archived list); past bookings keep the
 * discount they received.
 */
export function PromoCodesCard() {
  const { confirmThen } = useConfirmAction();
  const { settings } = useConfig();
  const vehicleTypes = settings.VEHICLE_TYPES || [];
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('promo_codes').select('*').order('created_at', { ascending: false });
    if (error) toast.error('Could not load promo codes.');
    setRows(data || []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const errors = useMemo(() => {
    const e = {};
    const code = draft.code.trim();
    const value = Number(draft.discount_value);
    if (!/^[A-Za-z0-9_-]{3,20}$/.test(code)) e.code = '3–20 letters, numbers, - or _.';
    if (!draft.name.trim()) e.name = 'Give the promotion a name.';
    if (!Number.isFinite(value) || value <= 0) e.discount_value = 'Enter a discount above 0.';
    else if (draft.discount_type === 'percentage' && value > 100) e.discount_value = 'A percentage cannot be above 100.';
    if (draft.valid_from && draft.valid_until && new Date(draft.valid_until) <= new Date(draft.valid_from)) e.valid_until = 'Must be after the start.';
    if (draft.max_uses !== '' && !(Number.isInteger(Number(draft.max_uses)) && Number(draft.max_uses) > 0)) e.max_uses = 'Whole number above 0, or leave empty.';
    return e;
  }, [draft]);
  const isValid = Object.keys(errors).length === 0;

  const set = (key) => (value) => setDraft((prev) => ({ ...prev, [key]: value }));
  const toggleVehicle = (value) => setDraft((prev) => ({
    ...prev,
    vehicle_types: prev.vehicle_types.includes(value) ? prev.vehicle_types.filter((v) => v !== value) : [...prev.vehicle_types, value]
  }));

  const create = async () => {
    setSaving(true);
    try {
      const row = {
        code: draft.code.trim(),
        name: draft.name.trim(),
        discount_type: draft.discount_type,
        discount_value: Number(draft.discount_value),
        vehicle_types: draft.vehicle_types,
        valid_from: toIso(draft.valid_from),
        valid_until: toIso(draft.valid_until),
        max_uses: draft.max_uses === '' ? null : Number(draft.max_uses)
      };
      const { error } = await supabase.from('promo_codes').insert(row);
      if (error) throw error;
      await writeAdminAuditLog({ actionType: 'PROMO_CODE_CREATED', details: `Created promo code ${row.code.toUpperCase()} (${row.name}).`, metadata: { code: row.code.toUpperCase() } });
      toast.success(`Promo code ${row.code.toUpperCase()} created.`);
      setDraft(EMPTY);
      await load();
    } catch (error) {
      toast.error(error?.code === '23505' ? 'That code already exists.' : (error?.message || 'Could not create the code.'));
    } finally {
      setSaving(false);
    }
  };

  const archive = async (row) => {
    const { error } = await supabase.from('promo_codes').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', row.id);
    if (error) { toast.error(error.message || 'Could not archive the code.'); return; }
    await writeAdminAuditLog({ actionType: 'PROMO_CODE_ARCHIVED', details: `Archived promo code ${row.code}.`, metadata: { code: row.code } });
    toast.success(`Promo code ${row.code} archived.`);
    await load();
  };

  // Expired codes remain visible with their status; only archived and used-up
  // codes are moved behind the secondary list.
  const isPast = (row) => ['Archived', 'Used up'].includes(statusOf(row).label);
  const [showPast, setShowPast] = useState(false);
  const [pastVisible, setPastVisible] = useState(5);
  const currentRows = rows.filter((row) => !isPast(row));
  const pastRows = rows.filter(isPast);
  const shownRows = showPast ? pastRows.slice(0, pastVisible) : currentRows;

  const discountLabel = (row) => (row.discount_type === 'percentage' ? `${Number(row.discount_value)}% off` : `${formatPeso(Number(row.discount_value))} off`);
  const scopeLabel = (row) => (row.vehicle_types?.length ? row.vehicle_types.join(', ') : 'All vehicles');

  return (
    <Card className="ui-root mt-4">
      <CardHeader>
        <CardTitle>Promo codes</CardTitle>
        <CardDescription>Optional codes a customer can type on the last booking page. A code can be archived, never deleted; past bookings keep the discount they already received.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="pc-code">Code</Label>
            <Input id="pc-code" data-no-auto-capitalize="true" value={draft.code} onChange={(e) => set('code')(e.target.value.replace(/\s/g, '').toUpperCase())} placeholder="SUMMER10" aria-invalid={Boolean(draft.code && errors.code)} />
            {draft.code && errors.code && <p className="text-xs text-destructive">{errors.code}</p>}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pc-name">Name</Label>
            <Input id="pc-name" value={draft.name} onChange={(e) => set('name')(e.target.value)} placeholder="Summer wash promo" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pc-type">Discount</Label>
            <div className="flex gap-2">
              <select id="pc-type" value={draft.discount_type} onChange={(e) => set('discount_type')(e.target.value)} className="h-9 rounded-md border bg-transparent px-2 text-sm">
                <option value="percentage">Percent (%)</option>
                <option value="fixed">Fixed (₱)</option>
              </select>
              <Input inputMode="decimal" value={draft.discount_value} onChange={(e) => set('discount_value')(e.target.value.replace(/[^0-9.]/g, ''))} placeholder={draft.discount_type === 'percentage' ? '10' : '100'} aria-label="Discount value" aria-invalid={Boolean(draft.discount_value && errors.discount_value)} />
            </div>
            {draft.discount_value && errors.discount_value && <p className="text-xs text-destructive">{errors.discount_value}</p>}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pc-max">Usage limit: number of customers (optional)</Label>
            <Input id="pc-max" inputMode="numeric" value={draft.max_uses} onChange={(e) => set('max_uses')(e.target.value.replace(/\D/g, ''))} placeholder="Unlimited" aria-describedby="pc-max-hint" />
            <p id="pc-max-hint" className="text-xs text-muted-foreground">How many customers can use this code. Each account can use it once.</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pc-from">Starts (optional)</Label>
            <Input id="pc-from" type="datetime-local" value={draft.valid_from} onChange={(e) => set('valid_from')(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pc-until">Ends (optional)</Label>
            <Input id="pc-until" type="datetime-local" value={draft.valid_until} onChange={(e) => set('valid_until')(e.target.value)} aria-invalid={Boolean(errors.valid_until)} />
            {errors.valid_until && <p className="text-xs text-destructive">{errors.valid_until}</p>}
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label>Applies to</Label>
          <div className="flex flex-wrap gap-2">
            {vehicleTypes.map((type) => (
              <Button key={type.value} type="button" size="sm" variant={draft.vehicle_types.includes(type.value) ? 'default' : 'outline'} aria-pressed={draft.vehicle_types.includes(type.value)} onClick={() => toggleVehicle(type.value)}>{type.label}</Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{draft.vehicle_types.length ? 'Only the selected vehicle types.' : 'Leave all unselected to apply to every vehicle type.'}</p>
        </div>
        <div className="flex justify-end">
          <Button disabled={!isValid || saving} title={!isValid ? 'Complete the required fields first' : undefined}
            onClick={() => confirmThen({ title: 'Create this promo code?', message: `${draft.code.toUpperCase()} will be usable by customers straight away (within its dates).`, confirmText: 'Create code' }, create)}>
            <Plus /> {saving ? 'Creating…' : 'Create code'}
          </Button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2 pr-3">Code</th><th className="pr-3">Discount</th><th className="pr-3">Applies to</th><th className="pr-3">Valid</th><th className="pr-3">Used</th><th className="pr-3">Status</th><th />
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={7} className="py-4 text-muted-foreground">Loading…</td></tr>}
              {!loading && shownRows.length === 0 && <tr><td colSpan={7} className="py-4 text-muted-foreground">{showPast ? 'No archived or used-up codes.' : 'No current promo codes.'}</td></tr>}
              {shownRows.map((row) => {
                const status = statusOf(row);
                return (
                  <tr key={row.id} className="border-b">
                    <td className="py-2 pr-3 font-mono font-semibold">{row.code}<div className="font-sans text-xs font-normal text-muted-foreground">{row.name}</div></td>
                    <td className="pr-3">{discountLabel(row)}</td>
                    <td className="pr-3">{scopeLabel(row)}</td>
                    <td className="pr-3">{fmtDate(row.valid_from)} → {row.valid_until ? fmtDate(row.valid_until) : 'No end'}</td>
                    <td className="pr-3 tabular-nums">{row.uses_count}{row.max_uses ? ` / ${row.max_uses}` : ''}</td>
                    <td className="pr-3"><Badge variant={status.variant}>{status.label}</Badge></td>
                    <td className="text-right">
                      {!showPast && status.label !== 'Expired' && (
                        <Button size="sm" variant="outline" aria-label={`Archive ${row.code}`}
                          onClick={() => confirmThen({ title: `Archive ${row.code}?`, message: 'The code stops working immediately and moves to the archived list. Past bookings keep the discount they received.', confirmText: 'Archive code', type: 'danger' }, () => archive(row))}>
                          <Archive /> Archive
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => { setShowPast((v) => !v); setPastVisible(5); }}>
            {showPast ? 'Back to current codes' : `View archived and used-up codes (${pastRows.length})`}
          </Button>
          {showPast && pastRows.length > pastVisible && (
            <Button type="button" variant="outline" size="sm" onClick={() => setPastVisible((n) => n + 5)}>See more</Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
