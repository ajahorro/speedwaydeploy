import React, { useState } from 'react';
import { HelpCircle, Bug, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../hooks/useAuth';
import { useUI } from '../../context/UIContext';
import { useConfig } from '../../context/ConfigContext';
import { APP_METADATA } from '../../config/legalContent';
import { SettingsSection, SettingRow, SettingButton, SettingTag } from './SettingsPrimitives';

/**
 * APP METADATA & SUPPORT FOOTER (Directive §3).
 *  - Build version line.
 *  - Support links: View FAQ + Report an Issue.
 *  - Data compliance: Request Account Data Deletion.
 *
 * "Report an Issue" and "Request Account Data Deletion" both file a durable
 * record in audit_logs (best-effort — the toast still confirms even if the
 * insert is unavailable, so the user is never blocked by a backend hiccup).
 *
 * View FAQ opens the shop's live FAQs in a modal (same data as the landing
 * page) so the user never has to leave their dashboard.
 */

// Fallback questions shown when the studio has not published any FAQs yet.
const FALLBACK_FAQS = [
  { question: 'How do I book a detailing service?', answer: 'Choose your vehicle and services in the booking wizard, pick a slot, then upload your proof of payment at checkout.' },
  { question: 'What payment methods are accepted?', answer: 'We accept GCash, bank transfer, and on-site cash. Digital payments require a valid proof of payment.' },
  { question: 'Can I reschedule my booking?', answer: 'Yes — you may reschedule a confirmed booking to another available slot at no extra cost, subject to availability.' },
];

const AppMetadataFooter = ({ onRequestDeletion = null, role = 'customer' }) => {
  const { user, profile } = useAuth();
  const { openModal } = useUI();
  const { settings } = useConfig();
  const [filing, setFiling] = useState(false);

  // Staff/admin accounts are operational accounts that must not be self-purged —
  // the studio owner controls their lifecycle. The data-deletion action is
  // therefore offered only to customers. (An admin who truly wants out is
  // handled through account deactivation / another admin, not this footer.)
  const showDeletion = role === 'customer';

  const recordSupportEvent = async (actionType, details) => {
    try {
      const { error } = await supabase.from('audit_logs').insert({
        action_type: actionType,
        // Stamp actor_id so the Audit Logs page can resolve the actor's email
        // (same shape the backend writeAuditLog helper produces).
        actor_id: user?.id || profile?.id || null,
        actor_name: profile?.full_name || user?.email || 'USER',
        actor_role: profile?.role || 'CUSTOMER',
        details,
        created_at: new Date().toISOString(),
      });
      // Supabase returns { error } instead of throwing — treat that as unrecorded
      // and log it so a silent RLS/schema failure is never invisible again.
      if (error) {
        console.warn(`[AppMetadataFooter] ${actionType} not recorded:`, error.code || '', error.message);
        return false;
      }
      return true;
    } catch (err) {
      console.warn(`[AppMetadataFooter] ${actionType} threw:`, err?.message || err);
      return false;
    }
  };

  const handleViewFaq = () => {
    const published = Array.isArray(settings?.FAQS) ? settings.FAQS.filter((f) => f && String(f.question || '').trim()) : [];
    const items = (published.length > 0 ? published : FALLBACK_FAQS).map((f) => ({
      question: String(f.question || '').trim(),
      answer: String(f.answer || '').trim(),
    }));

    openModal({
      title: 'Frequently Asked Questions',
      confirmText: 'Close',
      cancelText: null,
      type: 'info',
      message: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {items.map((f, i) => (
            <div key={i}>
              <div style={{ fontSize: '0.82rem', fontWeight: 900, color: 'var(--admin-text-primary)', marginBottom: '0.3rem' }}>
                {f.question}
              </div>
              <p style={{ margin: 0, fontSize: '0.78rem', lineHeight: 1.6, color: 'var(--admin-text-secondary)', fontWeight: 500 }}>
                {f.answer || 'Contact our support team for details on this.'}
              </p>
            </div>
          ))}
        </div>
      ),
    });
  };

  const handleReportIssue = () => {
    openModal({
      title: 'Report an Issue',
      message: 'Describe the problem you encountered. Our support team will follow up via your registered email address.',
      type: 'warning',
      prompt: true,
      inputLabel: 'What went wrong?',
      inputPlaceholder: 'e.g. My receipt upload keeps failing on the payment step.',
      confirmText: 'Submit Report',
      cancelText: 'Cancel',
      onConfirm: async (issue) => {
        setFiling(true);
        const recorded = await recordSupportEvent(
          'SUPPORT_ISSUE_REPORTED',
          `Issue reported by ${profile?.email || user?.email || 'user'}: ${issue}`
        );
        setFiling(false);
        if (recorded) {
          toast.success('Report submitted. Thank you for the feedback!');
        } else {
          toast.success(`Report noted. You can also email us at ${APP_METADATA.supportEmail}.`);
        }
      },
    });
  };

  const handleRequestDeletion = () => {
    // A dashboard may supply its own handler (e.g. the customer account
    // deactivation grace-period flow). Fall back to filing a support record.
    if (typeof onRequestDeletion === 'function') {
      onRequestDeletion();
      return;
    }
    openModal({
      title: 'Request Account Data Deletion',
      message: 'This raises a data-deletion request with our team. Your account is retained for a 15-day recovery window, after which all personal data is permanently purged. Do you want to continue?',
      type: 'danger',
      confirmText: 'Request Deletion',
      cancelText: 'Keep My Account',
      onConfirm: async () => {
        setFiling(true);
        const recorded = await recordSupportEvent(
          'ACCOUNT_DATA_DELETION_REQUESTED',
          `Data-deletion request submitted by ${profile?.email || user?.email || 'user'}.`
        );
        setFiling(false);
        if (recorded) {
          toast.success('Data-deletion request received. Our team will process it shortly.');
        } else {
          toast.success(`Data-deletion request noted. Contact ${APP_METADATA.supportEmail} to confirm.`);
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
        <SettingButton onClick={handleViewFaq}>
          <HelpCircle size={14} /> View FAQ
        </SettingButton>
      </SettingRow>

      <SettingRow title="Report an Issue" subtitle="Tell our team about a problem you encountered.">
        <SettingButton onClick={handleReportIssue} disabled={filing}>
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
        © {new Date().getFullYear()} Speedway AutoxMoto Detail Studio. All rights reserved. Support: {APP_METADATA.supportEmail}
      </div>
    </SettingsSection>
  );
};

export default AppMetadataFooter;