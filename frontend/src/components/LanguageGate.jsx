import { useState } from 'react';
import toast from '@/lib/toast';
import { Languages } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '../hooks/useAuth';
import { useConfig } from '../context/ConfigContext';
import { LANGUAGES, useLanguage } from '../context/LanguageContext';
import { isTermsPending } from './TermsGate';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * Asked once for every new account (customer, staff and administrator), right after the terms and conditions
 * are accepted. The choice can be changed any time in Settings.
 */
const LanguageGate = () => {
  const { profile } = useAuth();
  const { settings } = useConfig();
  const { needsChoice, setLanguage } = useLanguage();
  const [saving, setSaving] = useState('');

  if (!needsChoice || isTermsPending(profile, settings)) return null;

  const choose = async (value) => {
    setSaving(value);
    const result = await setLanguage(value);
    setSaving('');
    if (!result.success) toast.error('Could not save your language. Try again.');
  };

  return (
    <Dialog open>
      <DialogContent
        translate="no"
        showCloseButton={false}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
        className="ui-root sm:max-w-sm"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Languages className="size-5 text-primary" aria-hidden="true" />Choose your language / Piliin ang wika</DialogTitle>
          <DialogDescription>You can change this any time in Settings. / Maaari mo itong baguhin anumang oras sa Settings.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {LANGUAGES.map((lang) => (
            <Button key={lang.value} type="button" size="lg" variant={lang.value === 'en' ? 'default' : 'outline'} disabled={Boolean(saving)} onClick={() => choose(lang.value)}>
              {saving === lang.value ? '…' : lang.label}
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default LanguageGate;
