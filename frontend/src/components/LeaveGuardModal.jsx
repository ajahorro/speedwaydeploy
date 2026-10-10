import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';

/**
 * LeaveGuardModal
 * ============================================================================
 * The prompt shown by `useUnsavedChangesGuard` when a user tries to leave a form
 * with unsaved edits. Closing it (Esc) counts as staying on the page.
 */
const LeaveGuardModal = ({ open, message, onStay, onLeave }) => {
  if (!open) return null;

  return (
    <AlertDialog open onOpenChange={(next) => { if (!next) onStay?.(); }}>
      <AlertDialogContent className="ui-root">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-amber-500" aria-hidden="true" />
            Unsaved Changes
          </AlertDialogTitle>
          <AlertDialogDescription>{message || 'You have unsaved changes. Leave without saving?'}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button type="button" variant="outline" onClick={onLeave} className="border-destructive/60 text-destructive hover:text-destructive">Leave</Button>
          <Button type="button" onClick={onStay}>Stay</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default LeaveGuardModal;
