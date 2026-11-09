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

/**
 * The documents the signed-in account still has to agree to: the terms and conditions and the privacy & security
 * policy, each versioned per role. A document is due when it has text and its current version is newer than the one
 * this account agreed to (new accounts have agreed to nothing yet).
 */
const pendingDocs = (profile, settings) => {
  if (!profile?.id) return [];
  const key = roleKey(profile.role);
  const docs = [];
  const terms = settings?.TERMS?.[key];
  if (String(terms?.text || '').trim() && Number(profile.accepted_terms_version || 0) < Number(terms?.version || 1)) {
    docs.push({ id: 'terms', title: 'Terms and conditions', text: String(terms.text), version: Number(terms.version || 1), updated: Number(profile.accepted_terms_version || 0) > 0 });
  }
  const policy = settings?.SECURITY_POLICY?.[key];
  if (String(policy?.text || '').trim() && Number(profile.accepted_security_version || 0) < Number(policy?.version || 1)) {
    docs.push({ id: 'security', title: 'Privacy & security policy', text: String(policy.text), version: Number(policy.version || 1), updated: Number(profile.accepted_security_version || 0) > 0 });
  }
  return docs;
};

/** True while the signed-in account still has something to agree to. */
export const isTermsPending = (profile, settings) => pendingDocs(profile, settings).length > 0;

const ROLE_LABEL = { customer: 'Customer', staff: 'Staff', admin: 'Administrator' };

/**
 * Shown over the account (after signing in, and on a new account's first open) whenever the terms and conditions
 * or the privacy & security policy for this role has a version the person has not agreed to yet. Only the changed
 * document(s) are shown. The checkbox and the Agree button appear after scrolling to the end; the only other way out
 * is signing out. Agreeing records both documents' current versions (accept_current_policies), with an audit entry.
 */
const TermsGate = () => {
  const { profile, signOut, fetchProfile } = useAuth();
  const { settings } = useConfig();
  const bodyRef = useRef(null);
  const [atEnd, setAtEnd] = useState(false);
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);

  const key = roleKey(profile?.role);
  const docs = pendingDocs(profile, settings);
  const signature = docs.map((d) => `${d.id}:${d.version}`).join('|');

  const checkEnd = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 4) setAtEnd(true);
  }, []);

  useEffect(() => {
    if (!signature) return undefined;
    setAtEnd(false);
    setChecked(false);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    const timer = setTimeout(checkEnd, 200); // short texts that already fit need no scrolling
    return () => clearTimeout(timer);
  }, [signature, key, checkEnd]);

  if (!docs.length) return null;

  const accept = async () => {
    setSaving(true);
    try {
      let { error } = await supabase.rpc('accept_current_policies');
      // older database without the policy yet: the terms alone
      if (error && /accept_current_policies/i.test(String(error.message || '')) && docs.every((d) => d.id === 'terms')) {
        ({ error } = await supabase.rpc('accept_terms'));
      }
      if (error) throw error;
      await fetchProfile(profile.id, 'TERMS_ACCEPTED', true);
    } catch (error) {
      toast.error(error?.message || 'Could not record your agreement. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const both = docs.length > 1;
  const anyUpdated = docs.some((d) => d.updated);
  const title = both ? 'Terms and privacy & security policy' : docs[0].title;
  const agreeText = both
    ? 'I have read and agree to the terms and conditions and the privacy & security policy.'
    : docs[0].id === 'terms'
      ? 'I have read and agree to the terms and conditions.'
      : 'I have read and agree to the privacy & security policy.';

  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
        className="ui-root flex h-[min(36rem,88dvh)] max-h-[88dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
      >
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {anyUpdated
              ? 'We updated this since you last agreed. Please read it before you continue.'
              : 'Please read this before you continue.'}
          </DialogDescription>
        </DialogHeader>
        <div ref={bodyRef} onScroll={checkEnd} tabIndex={0} className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm leading-relaxed outline-none">
          {docs.map((doc, docIndex) => (
            <section key={doc.id} className={docIndex ? 'mt-6 border-t pt-5' : ''} aria-label={doc.title}>
              <h3 className="mb-3 text-sm font-semibold">
                {doc.title} <span className="font-normal text-muted-foreground">· {ROLE_LABEL[key]} · version {doc.version}</span>
              </h3>
              {doc.text.split(/\n+/).map((line) => line.trim()).filter(Boolean).map((line, index) => <p key={index} className="mb-3">{line}</p>)}
            </section>
          ))}
        </div>
        <div className="grid gap-3 border-t px-5 py-4">
          {!atEnd ? (
            <p role="status" className="text-sm font-medium text-muted-foreground">Scroll to the end to continue.</p>
          ) : (
            <label className="flex cursor-pointer items-start gap-2 text-sm font-medium">
              <Checkbox className="mt-0.5" checked={checked} onCheckedChange={(next) => setChecked(next === true)} />
              {agreeText}
            </label>
          )}
          <div className="flex flex-wrap justify-between gap-3">
            <Button type="button" variant="outline" onClick={() => signOut('/')}>Sign out</Button>
            {atEnd && (
              <Button type="button" onClick={accept} disabled={!checked || saving}>
                {saving ? 'Saving…' : 'Agree and continue'}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default TermsGate;
