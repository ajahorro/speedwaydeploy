import { useEffect, useMemo, useState } from 'react';
import toast from '@/lib/toast';
import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { supabase } from '@/lib/supabase';
import { useConfig } from '@/context/ConfigContext';
import { fetchShopConfig } from '@/config/shopConfig';
import { writeAdminAuditLog } from '@/services/auditLogService';
import { formatPeso } from '@/features/finance/money';
import { useConfirmAction } from '@/hooks/useConfirmAction';

const toDraft = (policy) => ({
  min_total: String(policy?.min_total ?? 1000),
  rate: String(Math.round(Number(policy?.rate ?? 0.3) * 100)),
  high_threshold: String(policy?.high_threshold ?? 2000),
  high_rate: String(Math.round(Number(policy?.high_rate ?? 0.5) * 100))
});

const validate = (draft) => {
  const errors = {};
  const minTotal = Number(draft.min_total);
  const threshold = Number(draft.high_threshold);
  const rate = Number(draft.rate);
  const highRate = Number(draft.high_rate);
  if (!Number.isFinite(minTotal) || minTotal < 0) errors.min_total = 'Enter an amount of ₱0 or more.';
  if (!Number.isFinite(threshold) || threshold < 0) errors.high_threshold = 'Enter an amount of ₱0 or more.';
  if (!Number.isFinite(rate) || rate <= 0 || rate > 100) errors.rate = 'Enter a percentage from 1 to 100.';
  if (!Number.isFinite(highRate) || highRate <= 0 || highRate > 100) errors.high_rate = 'Enter a percentage from 1 to 100.';
  return errors;
};

function Field({ id, label, hint, prefix, suffix, value, onChange, error }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        {prefix && <span className="text-sm text-muted-foreground">{prefix}</span>}
        <Input id={id} inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value)} aria-invalid={Boolean(error)} />
        {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * Business Hub › Payment Policy. Edits the downpayment policy stored on
 * business_config (migration 20261024000003). The database function
 * booking_required_downpayment() enforces it for booking creation, the staff
 * work-start gate and the ledger, so a save here changes every one of them.
 */
export function DownpaymentPolicyCard() {
  const { confirmThen } = useConfirmAction();
  const { settings } = useConfig();
  const configId = settings.config?.id;
  const current = settings.DOWNPAYMENT_POLICY;
  const [draft, setDraft] = useState(() => toDraft(current));
  const [saving, setSaving] = useState(false);

  // Follow live changes (another admin saving) while nothing is being edited.
  const currentKey = JSON.stringify(current);
  const [baseline, setBaseline] = useState(currentKey);
  useEffect(() => {
    if (currentKey !== baseline) {
      setDraft(toDraft(current));
      setBaseline(currentKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey]);

  const errors = validate(draft);
  const isValid = Object.keys(errors).length === 0;
  const isDirty = JSON.stringify(toDraft(current)) !== JSON.stringify(draft);

  // Preview of the DRAFT values (what the database will require once saved).
  const preview = useMemo(() => {
    if (!isValid) return [];
    const rate = Number(draft.rate) / 100;
    const highRate = Number(draft.high_rate) / 100;
    return [800, 1500, 2500, 5000].map((total) => {
      const allowed = total >= Number(draft.min_total);
      const tierRate = total >= Number(draft.high_threshold) ? highRate : rate;
      return { total, allowed, rate: tierRate, required: Math.round(total * tierRate * 100) / 100 };
    });
  }, [draft, isValid]);

  const save = async () => {
    if (!isValid || !configId) return;
    setSaving(true);
    const payload = {
      downpayment_min_total: Number(draft.min_total),
      downpayment_rate: Number(draft.rate) / 100,
      downpayment_high_threshold: Number(draft.high_threshold),
      downpayment_high_rate: Number(draft.high_rate) / 100
    };
    try {
      const { error } = await supabase.from('business_config').update(payload).eq('id', configId);
      if (error) throw error;
      await writeAdminAuditLog({
        actionType: 'BUSINESS_CONFIG_UPDATED',
        details: 'Updated the downpayment policy in the Business Hub.',
        metadata: { section: 'payments', before: current, after: payload }
      });
      await fetchShopConfig({ force: true });
      toast.success('Payment policy saved. New bookings use it immediately.');
    } catch (error) {
      console.error('Downpayment policy save failed:', error);
      toast.error(error?.message || 'Could not save the payment policy.');
    } finally {
      setSaving(false);
    }
  };

  const update = (key) => (value) => setDraft((prev) => ({ ...prev, [key]: value }));

  return (
    <Card className="ui-root">
      <CardHeader>
        <CardTitle>Downpayment policy</CardTitle>
        <CardDescription>
          How much a customer must pay before work starts. Bookings, staff assignment and every payment screen use
          these values.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="dp-min" label="Downpayment allowed from" prefix="₱" value={draft.min_total} onChange={update('min_total')} error={errors.min_total}
            hint="Bookings below this total are paid in full." />
          <Field id="dp-threshold" label="Higher rate from" prefix="₱" value={draft.high_threshold} onChange={update('high_threshold')} error={errors.high_threshold}
            hint="Bookings at or above this total use the higher rate." />
          <Field id="dp-rate" label="Standard rate" suffix="%" value={draft.rate} onChange={update('rate')} error={errors.rate}
            hint="Share of the booking total required up front." />
          <Field id="dp-high-rate" label="Higher rate" suffix="%" value={draft.high_rate} onChange={update('high_rate')} error={errors.high_rate}
            hint="Used for larger bookings." />
        </div>

        <Separator />

        <div>
          <p className="mb-2 text-sm font-semibold">Preview</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {preview.map((row) => (
              <div key={row.total} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                <span>Booking of {formatPeso(row.total)}</span>
                <span className="font-mono tabular-nums">
                  {row.allowed ? `${formatPeso(row.required)} (${Math.round(row.rate * 100)}%)` : 'Full payment'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button variant="ghost" disabled={!isDirty || saving} onClick={() => setDraft(toDraft(current))}>Discard</Button>
        <Button disabled={!isDirty || !isValid || saving || !configId} onClick={() => confirmThen({ title: 'Save payment policy?', message: 'New bookings will use the updated downpayment rules straight away.', confirmText: 'Save policy' }, save)}>
          <Save /> {saving ? 'Saving…' : 'Save policy'}
        </Button>
      </CardFooter>
    </Card>
  );
}
