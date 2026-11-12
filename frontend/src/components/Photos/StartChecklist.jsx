import React from 'react';
import { Check, Camera, Clock, UserCheck } from 'lucide-react';
import { startReadiness } from '../../utils/staffStart';

const ICONS = { duty: UserCheck, photo: Camera, time: Clock };
const HINTS = {
  duty: 'Clock in on the Duty & Shift page.',
  photo: 'Take a photo of the vehicle before work begins.',
  time: 'Opens at the scheduled time, or when an early start is allowed.'
};

/**
 * Shown right above START SERVICE so a technician can see exactly what is missing, and add the before photo from
 * the same spot (the button opens the same file picker as the "Intake photos (before)" box further down the card).
 * One row per requirement: a check when it is done, the step's own icon while it is not. Colours come from theme
 * tokens, so it follows light/dark, and rows stack cleanly on a phone.
 */
const StartChecklist = ({ taskId, clockedIn, beforePhotos, startDatetime, earlyStart = false, photoUploadEnabled = true }) => {
  const { steps } = startReadiness({ clockedIn, beforePhotos, startDatetime, earlyStart });
  const ready = steps.filter((s) => s.ok).length;

  return (
    <div
      role="group"
      aria-label="Before you can start this job"
      style={{ width: '100%', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius)', background: 'var(--admin-bg)', overflow: 'hidden' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', padding: '0.6rem 0.9rem', borderBottom: '1px solid var(--admin-border)' }}>
        <span style={{ fontSize: '0.72rem', fontWeight: 950, letterSpacing: '1px', textTransform: 'uppercase', color: 'var(--admin-text-secondary)' }}>Before you start</span>
        <span style={{ fontSize: '0.72rem', fontWeight: 800, color: ready === steps.length ? 'var(--status-success)' : 'var(--admin-text-secondary)' }}>{`${ready} of ${steps.length} ready`}</span>
      </div>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {steps.map((step, i) => {
          const Icon = step.ok ? Check : ICONS[step.key] || Clock;
          const showPhotoButton = step.key === 'photo' && !step.ok && photoUploadEnabled;
          return (
            <li
              key={step.key}
              style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', padding: '0.7rem 0.9rem', borderTop: i ? '1px solid var(--admin-border)' : 'none' }}
            >
              <span
                aria-hidden="true"
                style={{
                  display: 'grid', placeItems: 'center', width: '1.9rem', height: '1.9rem', flexShrink: 0, borderRadius: '50%',
                  background: step.ok ? 'var(--status-success-soft)' : 'var(--admin-card)',
                  color: step.ok ? 'var(--status-success)' : 'var(--admin-text-secondary)',
                  border: `1px solid ${step.ok ? 'var(--status-success-border)' : 'var(--admin-border)'}`
                }}
              >
                <Icon size={15} />
              </span>
              <div style={{ flex: '1 1 10rem', minWidth: 0 }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 800, color: step.ok ? 'var(--admin-text-secondary)' : 'var(--admin-text-primary)' }}>
                  {step.label}<span className="sr-only">{step.ok ? ' (done)' : ' (not done yet)'}</span>
                </div>
                {!step.ok && <div style={{ fontSize: '0.75rem', fontWeight: 600, lineHeight: 1.4, color: 'var(--admin-text-secondary)' }}>{HINTS[step.key]}</div>}
              </div>
              {showPhotoButton && (
                <label
                  htmlFor={`photo-input-${taskId}-before`}
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', minHeight: '2.25rem', padding: '0 0.9rem',
                    border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius)', background: 'var(--admin-card)', color: 'var(--admin-text-primary)',
                    fontWeight: 800, fontSize: '0.75rem', cursor: 'pointer', whiteSpace: 'nowrap'
                  }}
                >
                  <Camera size={14} /> Add photo
                </label>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default StartChecklist;
