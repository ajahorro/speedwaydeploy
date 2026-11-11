import { useEffect, useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import toast from '@/lib/toast';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmailInput } from '@/components/common/ContactInputs';
import PasswordInput from '@/components/PasswordInput';
import { emailError } from '@/utils/contactValidation';

const EMPTY = { step: 1, newEmail: '', password: '', currentCode: '', newCode: '' };
const digits = (v) => v.replace(/\D/g, '').slice(0, 6);

/**
 * Change the sign-in email (any account type): confirm with the current password, then enter one code
 * sent to the current address (it's really you) and one sent to the new address (you own it).
 */
export default function ChangeEmailDialog({ open, onOpenChange }) {
  const { user, requestEmailChange, confirmEmailChange } = useAuth();
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (open) { setForm(EMPTY); setError(''); } }, [open]);
  const set = (key, fn = (v) => v) => (e) => setForm((f) => ({ ...f, [key]: fn(e?.target ? e.target.value : e) }));

  const sendCodes = async (e) => {
    e.preventDefault();
    const problem = emailError(form.newEmail);
    if (problem) return setError(problem);
    if (form.newEmail.trim().toLowerCase() === String(user?.email || '').toLowerCase()) return setError('That is already your email address.');
    if (!form.password) return setError('Enter your current password.');
    setBusy(true); setError('');
    const res = await requestEmailChange(form.newEmail.trim(), form.password);
    setBusy(false);
    if (!res?.success) return setError(res?.error || 'The codes could not be sent. Please try again.');
    setForm((f) => ({ ...f, step: 2, password: '' }));
  };

  const confirm = async (e) => {
    e.preventDefault();
    if (form.currentCode.length !== 6 || form.newCode.length !== 6) return setError('Enter both 6-digit codes.');
    setBusy(true); setError('');
    const res = await confirmEmailChange(form.currentCode, form.newCode);
    setBusy(false);
    if (!res?.success) {
      if (res?.restart) setForm((f) => ({ ...f, step: 1, currentCode: '', newCode: '' }));
      return setError(res?.error || 'The codes could not be checked. Please try again.');
    }
    toast.success('Email address changed. Use the new address the next time you sign in.');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="ui-root sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change email address</DialogTitle>
          <DialogDescription>
            {form.step === 1
              ? <>You sign in with <strong className="break-all">{user?.email}</strong>. We will send a code to this address and one to the new address.</>
              : <>Enter the code sent to each address. They expire in 15 minutes.</>}
          </DialogDescription>
        </DialogHeader>

        {form.step === 1 ? (
          <form onSubmit={sendCodes} className="grid min-w-0 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="ce-new">New email address</Label>
              <EmailInput as={Input} id="ce-new" value={form.newEmail} onChange={set('newEmail')} autoComplete="email" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ce-pass">Current password</Label>
              <PasswordInput as={Input} id="ce-pass" value={form.password} onChange={set('password')} autoComplete="current-password" />
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" className="rounded-[2px]" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
              <Button type="submit" className="rounded-[2px]" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Send />}Send codes</Button>
            </DialogFooter>
          </form>
        ) : (
          <form onSubmit={confirm} className="grid min-w-0 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="ce-code-current">Code sent to <span className="break-all">{user?.email}</span></Label>
              <Input id="ce-code-current" inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" value={form.currentCode} onChange={set('currentCode', digits)} className="h-12 text-center text-xl tracking-[0.4em]" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ce-code-new">Code sent to <span className="break-all">{form.newEmail.trim().toLowerCase()}</span></Label>
              <Input id="ce-code-new" inputMode="numeric" placeholder="6-digit code" value={form.newCode} onChange={set('newCode', digits)} className="h-12 text-center text-xl tracking-[0.4em]" />
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="ghost" className="rounded-[2px]" onClick={() => setForm((f) => ({ ...f, step: 1, currentCode: '', newCode: '' }))} disabled={busy}>Didn't get a code? Start again</Button>
              <Button type="submit" className="rounded-[2px]" disabled={busy}>{busy && <Loader2 className="animate-spin" />}Change email</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
