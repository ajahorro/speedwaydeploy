import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

/**
 * A password box with an eye button that shows or hides what was typed.
 * Drop-in for `<input type="password" …>`: every prop passes straight through, so existing styles, classes,
 * refs, autoComplete and validation keep working. Pass `as={Input}` to wrap the shadcn Input instead of a
 * plain input. The wrapper is a full-width block, matching how these boxes are laid out.
 */
const PasswordInput = React.forwardRef(function PasswordInput({ as: Component = 'input', style, className, ...props }, ref) {
  const [visible, setVisible] = useState(false);
  const label = visible ? 'Hide password' : 'Show password';

  return (
    // A one-cell grid stacks the eye over the box without positioning the wrapper, so icons the page floats over
    // the box (the padlock on the left) still draw on top of it.
    <div style={{ display: 'grid', width: '100%' }}>
      <Component
        ref={ref}
        {...props}
        type={visible ? 'text' : 'password'}
        className={className}
        style={{ ...style, gridArea: '1 / 1', paddingRight: '2.75rem' }}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        // Keep focus (and the caret) in the password box while toggling.
        onMouseDown={(e) => e.preventDefault()}
        aria-label={label}
        aria-pressed={visible}
        title={label}
        style={{
          gridArea: '1 / 1', justifySelf: 'end', alignSelf: 'stretch', width: '2.75rem', zIndex: 1,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'transparent', border: 0, padding: 0, cursor: 'pointer',
          color: 'var(--admin-text-secondary, #6B7280)',
        }}
      >
        {visible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
      </button>
    </div>
  );
});

export default PasswordInput;
