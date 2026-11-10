import { useState } from 'react';
import { useConfig } from '../../context/ConfigContext';
import LegalReaderDialog from './LegalReaderDialog';

const DOCS = {
  terms: { title: 'Terms and Conditions', key: 'TERMS' },
  privacy: { title: 'Privacy & Security Policy', key: 'SECURITY_POLICY' },
};

/** Opens the customer Terms or Privacy Policy (from the Business Hub) in the shared reader. Returns [open(doc), dialog]. */
export default function usePolicyReader() {
  const { settings } = useConfig();
  const [doc, setDoc] = useState(null);
  const text = doc ? String(settings?.[DOCS[doc].key]?.customer?.text || '').trim() : '';
  const dialog = (
    <LegalReaderDialog open={Boolean(doc)} onOpenChange={(open) => { if (!open) setDoc(null); }} title={doc ? DOCS[doc].title : ''}>
      <div className="grid gap-3">
        {(text || 'This document is not available yet.').split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l, i) => <p key={i}>{l}</p>)}
      </div>
    </LegalReaderDialog>
  );
  return [setDoc, dialog];
}
