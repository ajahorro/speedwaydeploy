import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { ArrowLeft, Lock, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { BACKEND_URL, authHeaders } from '@/config/api';
import { PhoneInput } from '@/components/common/ContactInputs';
import { isValidPhPhone, normalizePhPhone } from '@/utils/contactValidation';

const NAME_PATTERN = /^[\p{L}][\p{L} .'-]{0,59}$/u;
const today = () => new Date().toISOString().slice(0, 10);

const toForm = (member) => ({
  first_name: member?.first_name || '',
  last_name: member?.last_name || '',
  phone_number: member?.phone_number || '',
  birthday: member?.birthday || '',
  hired_at: member?.hired_at || '',
  role: String(member?.role || 'STAFF').toUpperCase(),
  force_password_reset: false
});

const LABELS = {
  first_name: 'First name',
  last_name: 'Last name',
  phone_number: 'Mobile number',
  birthday: 'Birthday',
  hired_at: 'Hire date',
  role: 'Role'
};

const show = (value) => (value === '' || value == null ? '—' : String(value));

/**
 * Edit a staff or administrator account (master plan 4.8) in a pop-up, so the admin never leaves
 * the account list. The email address is shown but cannot be edited. Saving is a two-step flow
 * inside the same pop-up (form, then a review of exactly what will change), because the app's
 * confirmation dialog cannot sit on top of a modal. The server re-validates everything, writes
 * the audit entry, and enforces the role-safety rules (default admin, last admin, active services).
 */
export default function EditStaffDialog({ member, open, onOpenChange, onSaved, roleLocked = false, roleLockedReason = '' }) {
  const [form, setForm] = useState(() => toForm(member));
  const [step, setStep] = useState('form');
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState('');

  useEffect(() => {
    if (open) {
      setForm(toForm(member));
      setStep('form');
      setServerError('');
    }
  }, [open, member]);

  const original = useMemo(() => toForm(member), [member]);
  const set = (key) => (valueOrEvent) => setForm((prev) => ({ ...prev, [key]: valueOrEvent?.target ? valueOrEvent.target.value : valueOrEvent }));

  const errors = useMemo(() => {
    const e = {};
    if (!NAME_PATTERN.test(form.first_name.trim())) e.first_name = 'Enter a first name (letters only).';
    if (!NAME_PATTERN.test(form.last_name.trim())) e.last_name = 'Enter a last name (letters only).';
    if (!isValidPhPhone(form.phone_number)) e.phone_number = 'Enter an 11-digit mobile number starting with 09.';
    if (form.birthday && (form.birthday > today() || form.birthday < '1900-01-01')) e.birthday = 'Birthday cannot be in the future.';
    if (form.hired_at && (form.hired_at > today() || form.hired_at < '1990-01-01')) e.hired_at = 'Hire date cannot be in the future.';
    return e;
  }, [form]);

  const changes = useMemo(() => {
    const list = [];
    for (const key of Object.keys(LABELS)) {
      const before = key === 'phone_number' ? normalizePhPhone(original[key]) : String(original[key] ?? '').trim();
      const after = key === 'phone_number' ? normalizePhPhone(form[key]) : String(form[key] ?? '').trim();
      if (before !== after) list.push({ key, label: LABELS[key], before: original[key], after: form[key] });
    }
    return list;
  }, [form, original]);

  const hasChanges = changes.length > 0 || form.force_password_reset;
  const valid = Object.keys(errors).length === 0;

  const save = async () => {
    setSaving(true);
    setServerError('');
    try {
      const payload = { force_password_reset: form.force_password_reset };
      changes.forEach(({ key }) => { payload[key] = key === 'phone_number' ? normalizePhPhone(form[key]) : String(form[key]).trim() || null; });
      const response = await fetch(`${BACKEND_URL}/api/admin/staff/${member.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify(payload)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) throw new Error(result.error || 'The account could not be updated.');
      toast.success(form.force_password_reset
        ? (result.passwordResetSent === false ? 'Saved. The reset email could not be sent, but a password change is now required at next sign-in.' : 'Saved. A password reset link was emailed.')
        : 'Account updated.');
      onSaved?.(result.profile);
      onOpenChange(false);
    } catch (error) {
      setServerError(error.message);
      setStep('form');
    } finally {
      setSaving(false);
    }
  };

  const fieldClass = 'grid gap-1.5';
  const errorText = (key) => (errors[key] ? <p className="text-xs text-destructive">{errors[key]}</p> : null);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
      <DialogContent className="ui-root max-h-[92dvh] gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="border-b px-6 py-5">
          <DialogTitle>{step === 'review' ? 'Review changes' : `Edit ${member?.full_name || 'account'}`}</DialogTitle>
          <DialogDescription>
            {step === 'review' ? 'Check what will change, then confirm.' : 'Update the details for this account. The email address cannot be changed.'}
          </DialogDescription>
        </DialogHeader>

        {step === 'form' ? (
          <div className="grid max-h-[60dvh] gap-5 overflow-y-auto px-6 py-5">
            {serverError && <p role="alert" className="rounded-md border border-destructive/50 px-3 py-2 text-sm text-destructive">{serverError}</p>}

            <div className={fieldClass}>
              <Label htmlFor="es-email" className="flex items-center gap-1.5">Email <Lock className="size-3 text-muted-foreground" aria-hidden="true" /></Label>
              <Input id="es-email" value={member?.email || ''} readOnly disabled aria-readonly="true" />
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <div className={fieldClass}>
                <Label htmlFor="es-first">First name</Label>
                <Input id="es-first" value={form.first_name} onChange={set('first_name')} maxLength={60} aria-invalid={Boolean(errors.first_name)} data-no-auto-capitalize="true" />
                {errorText('first_name')}
              </div>
              <div className={fieldClass}>
                <Label htmlFor="es-last">Last name</Label>
                <Input id="es-last" value={form.last_name} onChange={set('last_name')} maxLength={60} aria-invalid={Boolean(errors.last_name)} data-no-auto-capitalize="true" />
                {errorText('last_name')}
              </div>
            </div>

            <div className={fieldClass}>
              <Label htmlFor="es-phone">Mobile number</Label>
              <PhoneInput as={Input} id="es-phone" value={form.phone_number} onChange={set('phone_number')} required showError={false} aria-invalid={Boolean(errors.phone_number)} />
              {errorText('phone_number')}
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <div className={fieldClass}>
                <Label htmlFor="es-birthday">Birthday</Label>
                <Input id="es-birthday" type="date" value={form.birthday} max={today()} onChange={set('birthday')} aria-invalid={Boolean(errors.birthday)} />
                {errorText('birthday')}
              </div>
              <div className={fieldClass}>
                <Label htmlFor="es-hired">Hire date</Label>
                <Input id="es-hired" type="date" value={form.hired_at} max={today()} onChange={set('hired_at')} aria-invalid={Boolean(errors.hired_at)} />
                {errorText('hired_at')}
              </div>
            </div>

            <div className={fieldClass}>
              <Label htmlFor="es-role">Role</Label>
              <select
                id="es-role"
                value={form.role}
                onChange={set('role')}
                disabled={roleLocked}
                className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              >
                <option value="STAFF">Staff (technician)</option>
                <option value="ADMIN">Administrator</option>
              </select>
              <p className="text-xs text-muted-foreground">
                {roleLocked ? roleLockedReason : 'Changing the role changes what this person can see and do the next time they sign in.'}
              </p>
            </div>

            <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3">
              <input type="checkbox" className="mt-0.5" checked={form.force_password_reset} onChange={(event) => setForm((prev) => ({ ...prev, force_password_reset: event.target.checked }))} />
              <span className="grid gap-0.5">
                <span className="text-sm font-semibold">Require a password reset</span>
                <span className="text-xs text-muted-foreground">They must choose a new password at their next sign-in, and a reset link is emailed to them.</span>
              </span>
            </label>
          </div>
        ) : (
          <div className="grid max-h-[60dvh] gap-4 overflow-y-auto px-6 py-5">
            <ul className="grid gap-2">
              {changes.map((change) => (
                <li key={change.key} className="grid gap-0.5 rounded-md border px-3 py-2 text-sm">
                  <span className="text-xs font-semibold uppercase text-muted-foreground">{change.label}</span>
                  <span><span className="text-muted-foreground line-through">{show(change.before)}</span> → <strong>{show(change.after)}</strong></span>
                </li>
              ))}
              {form.force_password_reset && (
                <li className="rounded-md border px-3 py-2 text-sm"><strong>Password reset required</strong> at next sign-in; a reset link will be emailed.</li>
              )}
            </ul>
            {changes.some((change) => change.key === 'role') && (
              <p role="note" className="rounded-md border border-amber-500/50 px-3 py-2 text-sm">
                {form.role === 'ADMIN'
                  ? 'This person will gain full administrator access, including payments, refunds and account management.'
                  : 'This person will lose administrator access and become a technician.'}
              </p>
            )}
          </div>
        )}

        <DialogFooter className="border-t px-6 py-4">
          {step === 'form' ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button disabled={!hasChanges || !valid} title={!hasChanges ? 'Change something first' : (!valid ? 'Fix the highlighted fields' : undefined)} onClick={() => setStep('review')}>
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
