import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { supabase } from '@/lib/supabase';
import { BACKEND_URL, authHeaders } from '@/config/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Staff accounts that have not signed in for a period chosen here are deactivated automatically
 * (back to a customer account, history kept). Off by default. Only an administrator can reactivate.
 * The list below shows the accounts that were deactivated for inactivity, each with a Reactivate button.
 */
export default function InactiveStaffPanel({ onChanged, confirmThen }) {
  const [loaded, setLoaded] = useState(false);
  const [configId, setConfigId] = useState(null);
  const [saved, setSaved] = useState({ enabled: false, after: 90, unit: 'days' });
  const [form, setForm] = useState({ enabled: false, after: 90, unit: 'days' });
  const [saving, setSaving] = useState(false);
  const [deactivated, setDeactivated] = useState([]);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    const [{ data: config }, { data: people }] = await Promise.all([
      supabase.from('business_config').select('id, staff_auto_deactivate_enabled, staff_auto_deactivate_after, staff_auto_deactivate_unit').order('id').limit(1).maybeSingle(),
      supabase.from('profiles').select('id, full_name, email, staff_deactivated_at, staff_deactivation_reason').not('staff_deactivated_at', 'is', null).order('staff_deactivated_at', { ascending: false })
    ]);
    if (config) {
      const next = { enabled: Boolean(config.staff_auto_deactivate_enabled), after: Number(config.staff_auto_deactivate_after) || 90, unit: config.staff_auto_deactivate_unit || 'days' };
      setConfigId(config.id);
      setSaved(next);
      setForm(next);
    }
    setDeactivated(people || []);
    setLoaded(true);
  }, []);

  useEffect(() => { load(); }, [load]);

  const afterNumber = Math.round(Number(form.after));
  const valid = Number.isFinite(afterNumber) && afterNumber >= 1 && afterNumber <= (form.unit === 'months' ? 120 : 3650);
  const changed = form.enabled !== saved.enabled || afterNumber !== saved.after || form.unit !== saved.unit;

  const save = async () => {
    if (!configId || !valid) return;
    setSaving(true);
    const { error } = await supabase.from('business_config').update({
      staff_auto_deactivate_enabled: form.enabled,
      staff_auto_deactivate_after: afterNumber,
      staff_auto_deactivate_unit: form.unit
    }).eq('id', configId);
    setSaving(false);
    if (error) return toast.error('The setting could not be saved. Please try again.');
    toast.success(form.enabled ? 'Inactive staff accounts will be deactivated automatically.' : 'Automatic deactivation is off.');
    load();
  };

  const reactivate = async (person) => {
    setBusyId(person.id);
    try {
      const response = await fetch(`${BACKEND_URL}/api/admin/reactivate-staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ memberId: person.id })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) throw new Error(result.error || 'The account could not be reactivated.');
      toast.success(`${person.full_name || person.email} is a staff account again.`);
      await load();
      onChanged?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusyId(null);
    }
  };

  if (!loaded || !configId) return null;

  return (
    <Card className="ui-root">
      <CardHeader>
        <CardTitle className="text-base">Inactive staff accounts</CardTitle>
        <CardDescription>
          Deactivate staff who have not signed in for a set time. A deactivated account becomes a customer account (history is kept) and only an administrator can reactivate it. Staff with active work are skipped.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex items-center gap-2">
            <Switch id="auto-deactivate" checked={form.enabled} onCheckedChange={(enabled) => setForm((prev) => ({ ...prev, enabled }))} />
            <Label htmlFor="auto-deactivate">Deactivate automatically</Label>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="auto-deactivate-after" className="text-xs">After no sign-in for</Label>
            <div className="flex gap-2">
              <Input id="auto-deactivate-after" type="number" min={1} className="w-24" value={form.after} disabled={!form.enabled} onChange={(event) => setForm((prev) => ({ ...prev, after: event.target.value }))} aria-invalid={!valid} />
              <select
                aria-label="Unit"
                className="rounded-md border bg-background px-2 text-sm"
                value={form.unit}
                disabled={!form.enabled}
                onChange={(event) => setForm((prev) => ({ ...prev, unit: event.target.value }))}
              >
                <option value="days">days</option>
                <option value="months">months</option>
              </select>
            </div>
          </div>
          <Button
            disabled={!changed || !valid || saving}
            onClick={() => confirmThen
              ? confirmThen({ title: 'Save this setting?', message: form.enabled ? `Staff who have not signed in for ${afterNumber} ${form.unit} will be deactivated automatically.` : 'Automatic deactivation will be turned off.', confirmText: 'Save' }, save)
              : save()}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
        {!valid && form.enabled && <p role="alert" className="text-xs text-destructive">Enter a whole number from 1 to {form.unit === 'months' ? 120 : 3650}.</p>}

        {deactivated.length > 0 && (
          <div className="grid gap-2">
            <p className="text-xs font-semibold uppercase text-muted-foreground">Deactivated for inactivity</p>
            {deactivated.map((person) => (
              <div key={person.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{person.full_name || 'Unnamed'}</p>
                  <p className="truncate text-xs text-muted-foreground">{person.email} · {person.staff_deactivation_reason}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyId === person.id}
                  onClick={() => confirmThen
                    ? confirmThen({ title: 'Reactivate this account?', message: `${person.full_name || person.email} will be a staff account again.`, confirmText: 'Reactivate' }, () => reactivate(person))
                    : reactivate(person)}
                >
                  {busyId === person.id ? 'Reactivating…' : 'Reactivate'}
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
