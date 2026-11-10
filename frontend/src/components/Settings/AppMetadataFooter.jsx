import React, { useState } from 'react';
import { HelpCircle, Bug, UserX } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import toast from '@/lib/toast';
import { BACKEND_URL, authHeaders } from '../../config/api';
import { useUI } from '../../context/UIContext';
import { useConfig } from '../../context/ConfigContext';
import { APP_METADATA } from '../../config/legalContent';
import LegalReaderDialog from '../../features/legal/LegalReaderDialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SettingsSection, SettingRow, SettingButton, SettingTag } from './SettingsPrimitives';

/**
 * APP METADATA & SUPPORT FOOTER.
 *  - Build version line.
 *  - Support: View FAQ (the same short scrolling reader as the policies) and Report an Issue.
 *  - Deactivate Account (customers): 15-day recovery, then permanent deletion.
 *
 * "Report an Issue" is e-mailed to the developer support inbox by the server
 * (with the sender's name, role and e-mail, so support can reply), which also keeps a record in the audit log.
 */

// Fallback questions shown when the studio has not published any FAQs yet.
const FALLBACK_FAQS = [
  { question: 'How do I book a detailing service?', answer: 'Choose your vehicle and services in the booking wizard, pick a slot, then upload your proof of payment at checkout.' },
  { question: 'What payment methods are accepted?', answer: 'We accept GCash, bank transfer, and on-site cash. Digital payments require a valid proof of payment.' },
  { question: 'Can I reschedule my booking?', answer: 'Yes — you may reschedule a confirmed booking to another available slot at no extra cost, subject to availability.' },
];

const sendSupportReport = async ({ kind, message, elapsedMs, website = '' }) => {
  try {
    const response = await fetch(`${BACKEND_URL}/api/support/report`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ kind, message, elapsedMs, website, page: typeof window !== 'undefined' ? window.location.pathname : '' })
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok && body.success !== false, error: body.error, message: body.message, retryAfterSec: body.retryAfterSec };
  } catch {
    return { ok: false, error: 'The server could not be reached.' };
  }
};

const AppMetadataFooter = ({ role = 'customer' }) => {
  const { openModal } = useUI();
  const { deactivateAccount } = useAuth();
  const { settings } = useConfig();
  const [filing, setFiling] = useState(false);
  const [faqOpen, setFaqOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportText, setReportText] = useState('');
  // Anti-spam helpers (the server enforces the real limits): when the form opened, a hidden field only bots fill,
  // and a short local cooldown after a send or a "too many" answer.
  const [openedAt, setOpenedAt] = useState(0);
  const [trap, setTrap] = useState('');
  const [blockedUntil, setBlockedUntil] = useState(0);
  const [, forceTick] = useState(0);
  React.useEffect(() => {
    if (!blockedUntil) return undefined;
    const timer = setInterval(() => { if (Date.now() >= blockedUntil) setBlockedUntil(0); else forceTick((n) => n + 1); }, 1000);
    return () => clearInterval(timer);
  }, [blockedUntil]);
  const waitLeft = blockedUntil ? Math.max(0, Math.ceil((blockedUntil - Date.now()) / 1000)) : 0;
  const REPORT_MIN = 15;
  const REPORT_MAX = 2000;

  // Staff/admin accounts are operational accounts that must not be self-purged —
  // the studio owner controls their lifecycle. The data-deletion action is
  // therefore offered only to customers.
  const showDeletion = role === 'customer';

  const published = Array.isArray(settings?.FAQS) ? settings.FAQS.filter((f) => f && String(f.question || '').trim()) : [];
  const faqItems = (published.length > 0 ? published : FALLBACK_FAQS).map((f) => ({
    question: String(f.question || '').trim(),
    answer: String(f.answer || '').trim(),
  }));

  const submitReport = async () => {
    const message = reportText.trim();
    if (message.length < REPORT_MIN) { toast.error(`Please describe the problem in at least ${REPORT_MIN} characters.`); return; }
    if (waitLeft > 0) return;
    setFiling(true);
    const result = await sendSupportReport({ kind: 'ISSUE', message, elapsedMs: openedAt ? Date.now() - openedAt : null, website: trap });
    setFiling(false);
    if (result.ok) {
      toast.success(result.message || 'Report sent to our support team. Thank you!');
      setReportText('');
      setReportOpen(false);
      setBlockedUntil(Date.now() + 60000);
    } else {
      if (result.retryAfterSec) setBlockedUntil(Date.now() + Math.min(result.retryAfterSec, 3600) * 1000);
      toast.error(result.error || `The report could not be sent. You can email us at ${APP_METADATA.supportEmail}.`);
    }
  };

  // Deactivating starts a 15-day recovery period; signing in again within it brings the account back,
  // after that the account is deleted for good. The shop keeps its booking and payment records.
  const handleDeactivate = () => openModal({
    title: 'Deactivate account?',
    message: 'You will be signed out right away. Sign in again within 15 days to recover your account. After 15 days it is deleted permanently. The shop keeps your booking and payment records.',
    type: 'danger',
    confirmText: 'Deactivate',
    cancelText: 'Keep my account',
    onConfirm: async () => {
      setFiling(true);
      const result = await deactivateAccount();
      setFiling(false);
      if (result?.success) toast.success('Account deactivated. Sign in within 15 days to recover it.');
      else toast.error(result?.error || 'The account could not be deactivated.');
    },
  });

  return (
    <SettingsSection title="About & Support">
      <SettingRow title="App Version">
        <SettingTag>{APP_METADATA.buildLabel}</SettingTag>
      </SettingRow>

      <SettingRow title="Help Center" subtitle="Read the frequently asked questions.">
        <SettingButton onClick={() => setFaqOpen(true)}>
          <HelpCircle size={14} /> View FAQ
        </SettingButton>
      </SettingRow>

      <SettingRow title="Report an Issue" subtitle="Tell our team about a problem you encountered.">
        <SettingButton onClick={() => { setOpenedAt(Date.now()); setTrap(''); setReportOpen(true); }} disabled={filing}>
          <Bug size={14} /> Report
        </SettingButton>
      </SettingRow>

      {showDeletion && (
        <SettingRow
          title="Deactivate Account"
          subtitle="Sign in again within 15 days to recover it. After that it is deleted permanently."
        >
          <SettingButton variant="danger" onClick={handleDeactivate} disabled={filing}>
            <UserX size={14} /> Deactivate
          </SettingButton>
        </SettingRow>
      )}

      <div style={{ paddingTop: '1rem', fontSize: '0.7rem', color: 'var(--admin-text-secondary)', fontWeight: 500, lineHeight: 1.6, opacity: 0.85 }}>
        © {new Date().getFullYear()} Comar Garage. All rights reserved. Support: {APP_METADATA.supportEmail}
      </div>

      <LegalReaderDialog open={faqOpen} onOpenChange={setFaqOpen} title="Frequently Asked Questions" description="Answers to the questions we hear most.">
        <div className="grid gap-4">
          {faqItems.map((f, i) => (
            <div key={i}>
              <p className="mb-1 text-sm font-bold">{f.question}</p>
              <p className="m-0 text-sm text-muted-foreground">{f.answer || 'Contact our support team for details on this.'}</p>
            </div>
          ))}
        </div>
      </LegalReaderDialog>

      <Dialog open={reportOpen} onOpenChange={(next) => { if (!filing) setReportOpen(next); }}>
        <DialogContent className="ui-root sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Report an Issue</DialogTitle>
            <DialogDescription>Describe the problem you encountered. It goes straight to our support team, who will follow up via your registered email address.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="support-report">What went wrong?</Label>
            <Textarea id="support-report" rows={5} value={reportText} onChange={(event) => setReportText(event.target.value)} maxLength={REPORT_MAX} placeholder="e.g. My receipt upload keeps failing on the payment step." aria-describedby="support-report-hint" />
            <p id="support-report-hint" className="flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground">
              <span>{waitLeft > 0 ? `You can send another report in ${waitLeft >= 120 ? `${Math.ceil(waitLeft / 60)} minutes` : `${waitLeft} s`}.` : `At least ${REPORT_MIN} characters. One report a minute, up to 3 an hour.`}</span>
              <span>{reportText.trim().length}/{REPORT_MAX}</span>
            </p>
            {/* Bot trap: hidden from people and screen readers; real users never fill it in. */}
            <input type="text" name="website" value={trap} onChange={(event) => setTrap(event.target.value)} tabIndex={-1} autoComplete="off" aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, opacity: 0 }} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setReportOpen(false)} disabled={filing}>Cancel</Button>
            <Button type="button" onClick={submitReport} disabled={filing || waitLeft > 0 || reportText.trim().length < REPORT_MIN}>{filing ? 'Sending…' : 'Submit Report'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
};

export default AppMetadataFooter;
