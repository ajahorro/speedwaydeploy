import { useEffect, useState } from 'react';
import toast from '@/lib/toast';
import { ScrollText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/lib/supabase';
import { useConfig } from '@/context/ConfigContext';
import { fetchShopConfig } from '@/config/shopConfig';
import { useConfirmAction } from '@/hooks/useConfirmAction';

const AUDIENCES = [
  { key: 'customer', label: 'Customers', hint: 'Shown on the last booking page and to every customer when they open their account.' },
  { key: 'staff', label: 'Staff', hint: 'Every technician reads and accepts this when they open their account.' },
  { key: 'admin', label: 'Administrators', hint: 'Every administrator reads and accepts this when they open their account.' }
];

/**
 * Business Hub › Terms. One editable, versioned text per role (master plan 1.11 / 4.5).
 * Publishing goes through publish_terms(), which bumps that role's version (so everyone in
 * the role is asked again) and writes the audit log.
 */
export function TermsEditorCard() {
  const { confirmThen } = useConfirmAction();
  const { settings } = useConfig();
  const [audience, setAudience] = useState('customer');
  const current = settings.TERMS?.[audience] || { text: '', version: 1 };
  const [draft, setDraft] = useState(current.text);
  const [saving, setSaving] = useState(false);

  // Switching audience, or another admin publishing, resets the editor to the live text.
  useEffect(() => {
    setDraft(current.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audience, current.text, current.version]);

  const isDirty = draft.trim() !== current.text.trim();
  const isValid = draft.trim().length > 0;
  const meta = AUDIENCES.find((item) => item.key === audience);

  const publish = async () => {
    setSaving(true);
    try {
      const { data, error } = await supabase.rpc('publish_terms', { p_role: audience, p_text: draft });
      if (error) throw error;
      await fetchShopConfig({ force: true });
      toast.success(`Published version ${data?.version} of the ${meta.label.toLowerCase()} terms.`);
    } catch (error) {
      toast.error(error?.message || 'Could not publish the terms.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="ui-root">
      <CardHeader>
        <CardTitle>Terms and conditions</CardTitle>
        <CardDescription>Each role has its own text. Publishing a changed text asks everyone in that role to read and accept it again the next time they open their account.</CardDescription>
        <div className="flex flex-wrap gap-2 pt-2" role="tablist" aria-label="Terms audience">
          {AUDIENCES.map((item) => (
            <Button key={item.key} role="tab" aria-selected={audience === item.key} size="sm" variant={audience === item.key ? 'default' : 'outline'} onClick={() => setAudience(item.key)}>
              {item.label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-xs text-muted-foreground">{meta.hint} Current version: <strong>{current.version}</strong>. Put each clause on its own line.</p>
        <textarea
          aria-label={`${meta.label} terms and conditions`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={12}
          className="w-full rounded-md border bg-transparent p-3 text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button variant="ghost" disabled={!isDirty || saving} onClick={() => setDraft(current.text)}>Discard</Button>
        <Button
          disabled={!isDirty || !isValid || saving}
          title={!isDirty ? 'Edit the text first' : undefined}
          onClick={() => confirmThen({
            title: `Publish new ${meta.label.toLowerCase()} terms?`,
            message: `This becomes version ${current.version + 1}. Everyone in this role must accept it again the next time they open their account.`,
            confirmText: 'Publish'
          }, publish)}
        >
          <ScrollText /> {saving ? 'Publishing…' : 'Publish new version'}
        </Button>
      </CardFooter>
    </Card>
  );
}
