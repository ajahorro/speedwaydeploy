import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';

/**
 * Auth-screen input: shadcn Input with a leading icon. Every prop (name, type, autoComplete, readOnly, pattern...)
 * passes straight through. Password fields get an eye button on the right that shows or hides what was typed.
 */
const StyledInput = ({ icon: Icon, type, placeholder, value, onChange, required = false, autoComplete, name, readOnly = false, ...rest }) => {
  const isPassword = type === 'password';
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative w-full">
      <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 z-10 flex items-center pl-4 text-muted-foreground">
        <Icon size={18} />
      </div>
      <Input
        name={name}
        type={isPassword && visible ? 'text' : type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        required={required}
        autoComplete={autoComplete}
        readOnly={readOnly}
        aria-readonly={readOnly || undefined}
        {...rest}
        className={`h-12 pl-11 ${isPassword ? 'pr-12' : ''} text-sm font-semibold shadow-none ${readOnly ? 'bg-muted' : 'bg-background'}`}
      />
      {isPassword && (
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          // Keep focus (and the caret position) in the password box while toggling.
          onMouseDown={(e) => e.preventDefault()}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          title={visible ? 'Hide password' : 'Show password'}
          className="absolute inset-y-0 right-0 z-10 flex w-11 items-center justify-center border-0 bg-transparent p-0 text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
        >
          {visible ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      )}
    </div>
  );
};

export default StyledInput;
