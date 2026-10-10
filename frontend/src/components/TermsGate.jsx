import { useCallback, useEffect, useRef, useState } from 'react';
import toast from '@/lib/toast';
import { supabase } from '../lib/supabase';
import { useAuth } from '../hooks/useAuth';
import { useConfig } from '../context/ConfigContext';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const roleKey = (role) => {
  const value = String(role || '').toUpperCase();
  if (value === 'STAFF') return 'staff';
  if (value === 'ADMIN' || value === 'SUPER_ADMIN') return 'admin';
  return 'customer';
};

/** True while the signed-in account still has to accept its current terms. */
export const isTermsPending = (profile, settings) => {
  const terms = settings?.TERMS?.[roleKey(profile?.role)];
  const text = String(terms?.text || '').trim();
  return Boolean(profile?.id && text && Number(profile.accepted_terms_version || 0) < Number(terms?.version || 1));
};

const TITLES = { customer: 'Customer Terms & Conditions', staff: 'Staff Terms & Conditions', admin: 'Administrator Terms & Conditions' };

/**
 * First-open terms and conditions (master plan 1.11). Shows the signed-in role's own text
 * over the account until its current version is accepted. The checkbox and the Accept button
 * appear only after the person has scrolled to the end. The only other way out is signing out.
 */
const TermsGate = () => {
  const { profile, signOut, fetchProfile } = useAuth();
  const { settings } = useConfig();
  const bodyRef = useRef(null);
  const [atEnd, setAtEnd] = useState(false);
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);

  const key = roleKey(profile?.role);
  const terms = settings?.TERMS?.[key];
  const text = String(terms?.text || '').trim();
  const version = Number(terms?.version || 1);
  const needsAcceptance = Boolean(profile?.id && text && Number(profile.accepted_terms_version || 0) < version);

  const checkEnd = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 4) setAtEnd(true);
  }, []);

  useEffect(() => {
    if (!needsAcceptance) return undefined;
    setAtEnd(false);
    setChecked(false);
    const timer = setTimeout(checkEnd, 200); // short texts that already fit need no scrolling
    return () => clearTimeout(timer);
  }, [needsAcceptance, version, key, checkEnd]);

  if (!needsAcceptance) return null;

  const accept = async () => {
    setSaving(true);
    try {
      const { error } = await supabase.rpc('accept_terms');
      if (error) throw error;
      await fetchProfile(profile.id, 'TERMS_ACCEPTED', true);
    } catch (error) {
      toast.error(error?.message || 'Could not record your acceptance. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
        className="ui-root flex max-h-[92dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>{TITLES[key]}</DialogTitle>
          <DialogDescription>Please read these terms before you continue.</DialogDescription>
        </DialogHeader>
        <div ref={bodyRef} onScroll={checkEnd} tabIndex={0} className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm leading-relaxed outline-none">
          {text.split(/\n+/).map((line) => line.trim()).filter(Boolean).map((line, index) => <p key={index} className="mb-3">{line}</p>)}
        </div>
        <div className="grid gap-3 border-t px-5 py-4">
          {!atEnd ? (
            <p role="status" className="text-sm font-medium text-muted-foreground">Scroll to the end to continue.</p>
          ) : (
            <label className="flex cursor-pointer items-start gap-2 text-sm font-medium">
              <Checkbox className="mt-0.5" checked={checked} onCheckedChange={(next) => setChecked(next === true)} />
              I have read and agree to the terms and conditions.
            </label>
          )}
          <div className="flex flex-wrap justify-between gap-3">
            <Button type="button" variant="outline" onClick={() => signOut()}>Sign out</Button>
            {atEnd && (
              <Button type="button" onClick={accept} disabled={!checked || saving}>
                {saving ? 'Saving…' : 'Accept and continue'}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default TermsGate;
