import React, { useState } from 'react';
import LegalReaderDialog from '../../features/legal/LegalReaderDialog';
import { ScrollText, ShieldCheck, Receipt, ChevronRight } from 'lucide-react';
import { LEGAL_DOCUMENTS } from '../../config/legalContent';
import { useAuth } from '../../hooks/useAuth';
import { useConfig } from '../../context/ConfigContext';
import { SettingsSection, SettingRow } from './SettingsPrimitives';

/**
 * LEGAL & POLICIES (Directive §1).
 * Flat, line-divided rows — one per policy document. Clicking a row opens the
 * document in the shared modal system (so it is never blocked like window.open).
 * No nested card backgrounds; the divider lines carry the structure.
 */

const ICONS = {
  terms: ScrollText,
  privacy: ShieldCheck,
  cancellation: Receipt,
};

// Renders the structured document body inside the modal.
const LegalDocumentBody = ({ doc }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
    {doc.sections.map((section) => (
      <div key={section.heading}>
        {section.heading && <div style={{ fontSize: '0.8rem', fontWeight: 900, color: 'var(--admin-text-primary)', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          {section.heading}
        </div>}
        {section.paragraphs.map((p, i) => (
          <p key={i} style={{ margin: '0 0 0.5rem', fontSize: '0.82rem', lineHeight: 1.7, color: 'var(--admin-text-secondary)', fontWeight: 500 }}>
            {p}
          </p>
        ))}
      </div>
    ))}
  </div>
);

const LegalPoliciesCard = () => {
  const { profile } = useAuth();
  const { settings } = useConfig();
  const [openDoc, setOpenDoc] = useState(null);
  // The Terms of Service shown here are the very terms this account type accepts when it first opens the app
  // (edited in the Business Hub), so the two can never disagree. The static text is only the fallback.
  const roleKey = ['ADMIN', 'SUPER_ADMIN'].includes(String(profile?.role || '').toUpperCase()) ? 'admin' : (String(profile?.role || '').toUpperCase() === 'STAFF' ? 'staff' : 'customer');
  const acceptedTerms = String(settings?.TERMS?.[roleKey]?.text || '').trim();
  const documents = LEGAL_DOCUMENTS.map((doc) => (doc.id === 'terms' && acceptedTerms
    ? { ...doc, sections: [{ heading: '', paragraphs: acceptedTerms.split(/\n+/).map((line) => line.trim()).filter(Boolean) }] }
    : doc));
  const openDocument = (doc) => setOpenDoc(doc);

  return (
    <SettingsSection title="Legal & Policies">
      {documents.map((doc) => {
        const Icon = ICONS[doc.id] || ScrollText;
        return (
          <SettingRow
            key={doc.id}
            title={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                <Icon size={16} color="var(--admin-brand)" /> {doc.title}
              </span>
            }
            subtitle={doc.summary}
            onClick={() => openDocument(doc)}
          >
            <ChevronRight size={18} style={{ color: 'var(--admin-text-secondary)', opacity: 0.6 }} />
          </SettingRow>
        );
      })}
      <LegalReaderDialog open={Boolean(openDoc)} onOpenChange={(next) => { if (!next) setOpenDoc(null); }} title={openDoc?.title || ''} description={openDoc?.summary}>
        {openDoc && <LegalDocumentBody doc={openDoc} />}
      </LegalReaderDialog>
    </SettingsSection>
  );
};

export default LegalPoliciesCard;