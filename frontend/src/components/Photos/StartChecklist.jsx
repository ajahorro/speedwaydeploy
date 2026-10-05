import React from 'react';
import { CheckCircle2, Circle, Camera } from 'lucide-react';
import { startReadiness } from '../../utils/staffStart';

/**
 * Shown right above START SERVICE so a technician can see exactly what is
 * missing, and add the before photo from the same spot (the button opens the same
 * file picker as the "Intake photos (before)" box further down the card).
 */
const StartChecklist = ({ taskId, clockedIn, beforePhotos, startDatetime, photoUploadEnabled = true }) => {
  const { steps } = startReadiness({ clockedIn, beforePhotos, startDatetime });
  const needsPhoto = beforePhotos < 1;

  return (
    <div
      role="group"
      aria-label="Before you can start this job"
      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.6rem', width: '100%' }}
    >
      {steps.map((step) => (
        <span
          key={step.key}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '0.35rem', padding: '0.3rem 0.6rem',
            borderRadius: '999px', fontSize: '0.68rem', fontWeight: 800,
            border: `1px solid ${step.ok ? 'var(--status-success-border)' : 'var(--status-warning)'}`,
            color: step.ok ? 'var(--status-success)' : 'var(--status-warning)',
            background: step.ok ? 'var(--status-success-soft)' : 'transparent'
          }}
        >
          {step.ok ? <CheckCircle2 size={13} /> : <Circle size={13} />} {step.label}
        </span>
      ))}

      {needsPhoto && photoUploadEnabled && (
        <label
          htmlFor={`photo-input-${taskId}-before`}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '0.45rem', padding: '0.55rem 1rem',
            background: 'var(--admin-brand)', color: 'var(--admin-text-on-brand)', borderRadius: '6px',
            fontWeight: 900, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em',
            cursor: 'pointer'
          }}
        >
          <Camera size={14} /> Add before photo
        </label>
      )}
    </div>
  );
};

export default StartChecklist;
