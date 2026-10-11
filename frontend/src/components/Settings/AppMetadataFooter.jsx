import React, { useState } from 'react';
import { HelpCircle, Bug, Trash2 } from 'lucide-react';
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
 *  - Data compliance: Request Account Data Deletion (customers).
 *
 * "Report an Issue" and "Request Account Data Deletion" are e-mailed to the developer support inbox by the server
 * (with the sender's name, role and e-mail, so support can reply), which also keeps a record in the audit log.
 */

// Fallback questions shown when the studio has not published any FAQs yet.
const FALLBACK_FAQS = [
  { question: 'How do I book a detailing service?', answer: 'Choose your vehicle and services in the booking wizard, pick a slot, then upload your proof of payment at checkout.' },
  { question: 'What payment methods are accepted?', answer: 'We accept GCash, bank transfer, and on-site cash. Digital payments require a valid proof of payment.' },
  { question: 'Can I reschedule my booking?', answer: 'Yes — you may reschedule a confirmed booking to another available slot at no extra cost, subject to availability.' },
];

const sendSupportReport = async ({ kind, message }) => {
  try {
    const response = await fetch(`${BACKEND_URL}/api/support/report`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ kind, message, page: typeof window !== 'undefined' ? window.location.pathname : '' })
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok && body.success !== false, error: body.error };
  } catch {
    return { ok: false, error: 'The server could not be reached.' };
  }
};

const AppMetadataFooter = ({ onRequestDeletion = null, role = 'customer' }) => {
  const { openModal } = useUI();
  const { settings } = useConfig();
  const [filing, setFiling] = useState(false);
  const [faqOpen, setFaqOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportText, setReportText] = useState('');

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
    if (message.length < 5) { toast.error('Please describe the problem in a few words.'); return; }
    setFiling(true);
    const result = await sendSupportReport({ kind: 'ISSUE', message });
    setFiling(false);
    if (result.ok) {
      toast.success('Report sent to our support team. Thank you!');
      setReportText('');
      setReportOpen(false);
    } else {
      toast.error(result.error || `The report could not be sent. You can email us at ${APP_METADATA.supportEmail}.`);
    }
  };

  const handleRequestDeletion = () => {
    // A dashboard may supply its own handler (e.g. the customer account
    // deactivation grace-period flow). Fall back to sending a support request.
    if (typeof onRequestDeletion === 'function') {
      onRequestDeletion();
      return;
    }
    openModal({
      title: 'Request Account Data Deletion',
      message: 'This raises a data-deletion request with our team. Your account is retained for a 15-day recovery window, after which your account and personal details are permanently deleted. The shop keeps your booking and payment records. Do you want to continue?',
      type: 'danger',
      confirmText: 'Request Deletion',
      cancelText: 'Keep My Account',
      onConfirm: async () => {
        setFiling(true);
        const result = await sendSupportReport({ kind: 'DELETION_REQUEST', message: 'Please delete my account data (request sent from Settings).' });
        setFiling(false);
        if (result.ok) {
          toast.success('Data-deletion request received. Our team will process it shortly.');
        } else {
          toast.error(result.error || `The request could not be sent. Contact ${APP_METADATA.supportEmail} to confirm.`);
        }
      },
    });
  };

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
        <SettingButton onClick={() => setReportOpen(true)} disabled={filing}>
          <Bug size={14} /> Report
        </SettingButton>
      </SettingRow>

      {showDeletion && (
        <SettingRow
          title="Account Data Deletion"
          subtitle="Request permanent removal of your personal data (15-day recovery window applies)."
        >
          <SettingButton variant="danger" onClick={handleRequestDeletion} disabled={filing}>
            <Trash2 size={14} /> Request Deletion
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
            <Textarea id="support-report" rows={5} value={reportText} onChange={(event) => setReportText(event.target.value)} maxLength={4000} placeholder="e.g. My receipt upload keeps failing on the payment step." />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setReportOpen(false)} disabled={filing}>Cancel</Button>
            <Button type="button" onClick={submitReport} disabled={filing || reportText.trim().length < 5}>{filing ? 'Sending…' : 'Submit Report'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
};

export default AppMetadataFooter;
