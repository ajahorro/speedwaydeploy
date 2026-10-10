import { useEffect, useMemo, useState } from 'react';
import toast from '@/lib/toast';
import { ArrowLeft, History, Lock, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { BACKEND_URL, authHeaders } from '@/config/api';
import { PhoneInput } from '@/components/common/ContactInputs';
import { isValidPhPhone, normalizePhPhone } from '@/utils/contactValidation';
import WorkHistoryByDay from '@/features/staff-history/WorkHistoryByDay';

const NAME_PATTERN = /^[\p{L}][\p{L} .'-]{0,59}$/u;

const toForm = (member) => ({
  first_name: member?.first_name || '',
  last_name: member?.last_name || '',
  phone_number: member?.phone_number || '',
  can_view_reports: Boolean(member?.can_view_reports)
});

const LABELS = {
  first_name: 'First name',
  last_name: 'Last name',
  phone_number: 'Mobile number',
  can_view_reports: 'Can view reports'
};

const show = (value) => (value === true ? 'Yes' : value === false ? 'No' : value === '' || value == null ? '—' : String(value));

/**
 * Edit a staff or administrator account (master plan 4.8) in a pop-up, so the admin never leaves
 * the account list. The email address and join date are shown but cannot be edited. Saving is a
 * two-step flow inside the same pop-up (form, then a review of exactly what will change), because
 * the app's confirmation dialog cannot sit on top of a modal. The server re-validates everything,
 * writes the audit entry. An account keeps the role it was created with: it is shown here but cannot be changed.
 */
export default function EditStaffDialog({ member, open, onOpenChange, onSaved }) {
  const [form, setForm] = useState(() => toForm(member));
  const [step, setStep] = useState('form');
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState('');
  // A field's error appears once the person has left it (or pressed Review), never on a freshly opened form.
  const [touched, setTouched] = useState({});

  useEffect(() => {
    if (open) {
      setForm(toForm(member));
      setStep('form');
      setServerError('');
      setTouched({});
    }
  }, [open, member]);

  const original = useMemo(() => toForm(member), [member]);
  const set = (key) => (valueOrEvent) => setForm((prev) => ({ ...prev, [key]: valueOrEvent?.target ? valueOrEvent.target.value : valueOrEvent }));
  const touch = (key) => () => setTouched((prev) => ({ ...prev, [key]: true }));

  const errors = useMemo(() => {
    const e = {};
    if (!NAME_PATTERN.test(form.first_name.trim())) e.first_name = 'Enter a first name (letters only).';
    if (!NAME_PATTERN.test(form.last_name.trim())) e.last_name = 'Enter a last name (letters only).';
    if (!isValidPhPhone(form.phone_number)) e.phone_number = 'Enter an 11-digit mobile number starting with 09.';
    return e;
  }, [form]);

  const isStaffAccount = String(member?.role || '').toUpperCase() === 'STAFF';
  const changes = useMemo(() => {
    const list = [];
    for (const key of Object.keys(LABELS)) {
      if (key === 'can_view_reports' && !isStaffAccount) continue; // administrators already see reports
      const before = key === 'phone_number' ? normalizePhPhone(original[key]) : String(original[key] ?? '').trim();
      const after = key === 'phone_number' ? normalizePhPhone(form[key]) : String(form[key] ?? '').trim();
      if (before !== after) list.push({ key, label: LABELS[key], before: original[key], after: form[key] });
    }
    return list;
  }, [form, original, isStaffAccount]);

  const hasChanges = changes.length > 0;
  const valid = Object.keys(errors).length === 0;

  const review = () => {
    if (!valid) {
      setTouched({ first_name: true, last_name: true, phone_number: true });
      return;
    }
    setStep('review');
  };

  const save = async () => {
    setSaving(true);
    setServerError('');
    try {
      const payload = {};
      changes.forEach(({ key }) => {
        if (key === 'can_view_reports') payload[key] = Boolean(form[key]);
        else payload[key] = key === 'phone_number' ? normalizePhPhone(form[key]) : String(form[key]).trim() || null;
      });
      const response = await fetch(`${BACKEND_URL}/api/admin/staff/${member.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify(payload)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) throw new Error(result.error || 'The account could not be updated.');
      toast.success('Account updated.');
      onSaved?.(result.profile);
      onOpenChange(false);
    } catch (error) {
      setServerError(error.message);
      setStep('form');
    } finally {
      setSaving(false);
    }
  };

  const fieldClass = 'grid min-w-0 gap-1.5';
  const sectionTitle = 'text-xs font-semibold uppercase tracking-wide text-muted-foreground';
  const errorText = (key) => (touched[key] && errors[key] ? <p className="text-xs text-destructive">{errors[key]}</p> : null);
  const joined = member?.hired_at
    ? new Date(`${member.hired_at}T00:00:00`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : '—';
  const isStaff = isStaffAccount;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
      {/* grid-cols-[minmax(0,1fr)]: the pop-up keeps its own width instead of growing to fit its widest child. */}
      <DialogContent className="ui-root max-h-[92dvh] grid-cols-[minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-6 py-4 text-left">
          <DialogTitle>{step === 'review' ? 'Review changes' : (step === 'history' ? 'Attendance and bookings' : 'Edit account')}</DialogTitle>
          <DialogDescription>
            {step === 'review'
              ? 'Check what will change, then confirm.'
              : step === 'history'
                ? `${member?.full_name || 'This account'}: clock-ins and the vehicles worked, by day.`
                : (member?.full_name || member?.email || '')}
          </DialogDescription>
        </DialogHeader>

        {step === 'history' ? (
          <div className="max-h-[60dvh] min-w-0 overflow-y-auto px-6 py-5">
            <WorkHistoryByDay staffId={member?.id} isAdmin onNavigate={() => onOpenChange(false)} />
          </div>
        ) : step === 'form' ? (
          <div className="grid max-h-[62dvh] min-w-0 gap-6 overflow-y-auto px-6 py-5">
            {serverError && <p role="alert" className="rounded-md border border-destructive/50 px-3 py-2 text-sm text-destructive">{serverError}</p>}

            <section className="grid gap-4">
              <h3 className={sectionTitle}>Details</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className={fieldClass}>
                  <Label htmlFor="es-email" className="flex items-center gap-1.5">Email <Lock className="size-3 text-muted-foreground" aria-hidden="true" /></Label>
                  <Input id="es-email" value={member?.email || ''} readOnly disabled aria-readonly="true" className="truncate" />
                </div>
                <div className={fieldClass}>
                  <Label htmlFor="es-joined" className="flex items-center gap-1.5">Date joined <Lock className="size-3 text-muted-foreground" aria-hidden="true" /></Label>
                  <Input id="es-joined" value={joined} readOnly disabled aria-readonly="true" />
                </div>
                <div className={fieldClass}>
                  <Label htmlFor="es-first">First name</Label>
                  <Input id="es-first" value={form.first_name} onChange={set('first_name')} onBlur={touch('first_name')} maxLength={60} aria-invalid={Boolean(touched.first_name && errors.first_name)} data-no-auto-capitalize="true" />
                  {errorText('first_name')}
                </div>
                <div className={fieldClass}>
                  <Label htmlFor="es-last">Last name</Label>
                  <Input id="es-last" value={form.last_name} onChange={set('last_name')} onBlur={touch('last_name')} maxLength={60} aria-invalid={Boolean(touched.last_name && errors.last_name)} data-no-auto-capitalize="true" />
                  {errorText('last_name')}
                </div>
                <div className={`${fieldClass} sm:col-span-2`}>
                  <Label htmlFor="es-phone">Mobile number</Label>
                  <PhoneInput as={Input} id="es-phone" value={form.phone_number} onChange={set('phone_number')} onBlur={touch('phone_number')} required showError={false} aria-invalid={Boolean(touched.phone_number && errors.phone_number)} />
                  {errorText('phone_number')}
                </div>
              </div>
            </section>

            <section className="grid gap-4">
              <h3 className={sectionTitle}>Access</h3>
              <div className={fieldClass}>
                <Label htmlFor="es-role" className="flex items-center gap-1.5">Role <Lock className="size-3 text-muted-foreground" aria-hidden="true" /></Label>
                <Input id="es-role" value={isStaff ? 'Staff (technician)' : 'Administrator'} readOnly disabled aria-readonly="true" />
                <p className="text-xs text-muted-foreground">An account keeps the role it was created with.</p>
              </div>

              {isStaff && (
                <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5">
                  <div className="grid min-w-0 gap-0.5">
                    <Label htmlFor="es-reports" className="text-sm font-semibold">Can view reports</Label>
                    <p className="text-xs text-muted-foreground">Off by default.</p>
                  </div>
                  <Switch id="es-reports" checked={form.can_view_reports} onCheckedChange={(checked) => setForm((prev) => ({ ...prev, can_view_reports: checked }))} aria-label="Allow this staff member to view reports" />
                </div>
              )}

              {isStaff && (
                <Button type="button" variant="outline" className="justify-start" onClick={() => setStep('history')}>
                  <History /> Attendance and bookings
                </Button>
              )}
            </section>
          </div>
        ) : (
          <div className="grid max-h-[62dvh] min-w-0 gap-4 overflow-y-auto px-6 py-5">
            <ul className="grid gap-2">
              {changes.map((change) => (
                <li key={change.key} className="grid gap-0.5 rounded-md border px-3 py-2 text-sm">
                  <span className="text-xs font-semibold uppercase text-muted-foreground">{change.label}</span>
                  <span className="break-words"><span className="text-muted-foreground line-through">{show(change.before)}</span> → <strong>{show(change.after)}</strong></span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter className="border-t px-6 py-4">
          {step === 'history' ? (
            <Button variant="ghost" onClick={() => setStep('form')}><ArrowLeft /> Back to details</Button>
          ) : step === 'form' ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button disabled={!hasChanges} title={!hasChanges ? 'Change something first' : undefined} onClick={review}>
                Review changes
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" disabled={saving} onClick={() => setStep('form')}><ArrowLeft /> Back</Button>
              <Button disabled={saving} onClick={save}><Save /> {saving ? 'Saving…' : 'Confirm and save'}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
