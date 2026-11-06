import { Button } from '../ui/button';

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
  return (
    <footer className="flex flex-col gap-3 border-t border-border pt-6 mt-4 sm:flex-row sm:items-center sm:justify-end">
      <Button
        type="button"
        variant="outline"
        onClick={onBack}
        disabled={backDisabled}
        className="h-11 w-full min-w-0 px-8 font-black uppercase sm:w-auto"
      >
        Back
      </Button>

      {onCancel && (
        <Button
          type="button"
          onClick={onCancel}
          variant="outline"
          disabled={backDisabled}
          className="h-11 w-full min-w-0 border-destructive/60 px-6 font-bold uppercase text-destructive hover:text-destructive sm:w-auto"
        >
          Cancel
        </Button>
      )}

      <div className="flex w-full min-w-0 flex-col gap-2 sm:w-auto">
        {primarySupplement}
        <Button
          type="button"
          onClick={onPrimary}
          disabled={primaryDisabled}
          title={primaryTitle}
          className="h-11 w-full min-w-0 px-6 font-bold uppercase sm:w-auto"
        >
          {primaryLabel}
        </Button>
      </div>
    </footer>
  );
}
