import React, { forwardRef, useState } from 'react';
import {
  PHONE_LENGTH,
  EMAIL_MAX_LENGTH,
  sanitizePhoneInput,
  normalizePhPhone,
  sanitizeEmailInput,
  phoneError,
  emailError
} from '../../utils/contactValidation';

/**
 * Drop-in replacements for <input> (or any input-like component passed as `as`,
 * such as the login screens' StyledInput) that enforce the contact rules while
 * the person types.
 *
 *   <PhoneInput value={phone} onChange={(e) => setPhone(e.target.value)} />
 *   <EmailInput as={StyledInput} icon={Mail} value={email} onChange={...} />
 *
 * `onChange` still receives an event whose `target.value` is already clean, so
 * existing handlers keep working unchanged. A short message appears under the
 * field after the person leaves it with an invalid value. The rules live in
 * utils/contactValidation.js.
 */

const messageStyle = {
  margin: '0.35rem 0 0',
  fontSize: '0.7rem',
  fontWeight: 700,
  color: '#ef4444',
  lineHeight: 1.3
};

const useBlurError = () => {
  const [touched, setTouched] = useState(false);
  return [touched, setTouched];
};

const emit = (onChange, event, value) => {
  if (!onChange) return;
  if (event?.target) {
    if (event.target.value !== value) event.target.value = value;
    onChange(event);
  } else {
    onChange({ target: { value } });
  }
};

export const PhoneInput = forwardRef(function PhoneInput(
  { as: Component = 'input', value, onChange, onBlur, required = true, showError = true, ...props },
  ref
) {
  const [touched, setTouched] = useBlurError();
  const error = touched && showError ? phoneError(value, { required }) : '';

  return (
    <>
      <Component
        ref={ref}
        type="tel"
        inputMode="numeric"
        autoComplete="tel"
        placeholder="09123456789"
        required={required}
        {...props}
        value={value ?? ''}
        aria-invalid={error ? true : undefined}
        onChange={(event) => emit(onChange, event, sanitizePhoneInput(event.target.value))}
        onBlur={(event) => {
          setTouched(true);
          const normalized = normalizePhPhone(event.target.value);
          if (normalized !== event.target.value && /^\d+$/.test(normalized)) emit(onChange, event, normalized.slice(0, PHONE_LENGTH));
          if (onBlur) onBlur(event);
        }}
      />
      {error && <p role="alert" style={messageStyle}>{error}</p>}
    </>
  );
});

export const EmailInput = forwardRef(function EmailInput(
  { as: Component = 'input', value, onChange, onBlur, required = true, showError = true, ...props },
  ref
) {
  const [touched, setTouched] = useBlurError();
  const error = touched && showError ? emailError(value, { required }) : '';

  return (
    <>
      <Component
        ref={ref}
        type="email"
        inputMode="email"
        autoComplete="email"
        maxLength={EMAIL_MAX_LENGTH}
        required={required}
        {...props}
        value={value ?? ''}
        aria-invalid={error ? true : undefined}
        onChange={(event) => emit(onChange, event, sanitizeEmailInput(event.target.value).toLowerCase())}
        onBlur={(event) => {
          setTouched(true);
          if (onBlur) onBlur(event);
        }}
      />
      {error && <p role="alert" style={messageStyle}>{error}</p>}
    </>
  );
});
