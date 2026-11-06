import { Button } from '../ui/button';

/**
 * The one footer for every booking-wizard step: Back, optional Cancel, and the main action.
 * A note about the main action (for example why it is disabled) sits on its own line above the buttons,
 * so the three buttons always line up. On phones the buttons stack full width; from `sm` up they sit
 * in one row on the right.
 */
export default function BookingWizardActions({
  onBack,
  onCancel,
  onPrimary,
  primaryLabel,
  primaryDisabled = false,
  primaryTitle,
  primarySupplement,
  backDisabled = false
}) {
  const base = 'h-11 w-full min-w-0 px-6 font-bold uppercase sm:w-auto';
  return (
    <footer className="mt-4 flex flex-col gap-3 border-t border-border pt-6">
      {primarySupplement && <div className="flex sm:justify-end">{primarySupplement}</div>}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
        <Button type="button" variant="outline" onClick={onBack} disabled={backDisabled} className={base}>
          Back
        </Button>
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={backDisabled}
            className={`${base} border-destructive/60 text-destructive hover:text-destructive`}
          >
            Cancel
          </Button>
        )}
        <Button type="button" onClick={onPrimary} disabled={primaryDisabled} title={primaryTitle} className={base}>
          {primaryLabel}
        </Button>
      </div>
    </footer>
  );
}
