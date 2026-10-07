import React from 'react';
import { Input } from '@/components/ui/input';

/** Auth-screen input: shadcn Input with a leading icon. Every prop (name, type, autoComplete, readOnly, pattern...) passes straight through. */
const StyledInput = ({ icon: Icon, type, placeholder, value, onChange, required = false, autoComplete, name, readOnly = false, ...rest }) => (
  <div className="relative w-full">
    <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 z-10 flex items-center pl-4 text-muted-foreground">
      <Icon size={18} />
    </div>
    <Input
      name={name}
      type={type}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      required={required}
      autoComplete={autoComplete}
      readOnly={readOnly}
      aria-readonly={readOnly || undefined}
      {...rest}
      className={`h-12 pl-11 text-sm font-semibold shadow-none ${readOnly ? 'bg-muted' : 'bg-background'}`}
    />
  </div>
);

export default StyledInput;
