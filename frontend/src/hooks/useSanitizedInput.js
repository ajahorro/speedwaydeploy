import { useCallback } from 'react';
import { sanitizeByFieldType, FIELD_SANITIZERS } from '../config/constants';

/**
 * useSanitizedInput — Task 2.5: Context-Aware Field-Type Sanitization.
 * ============================================================================
 * A thin, reusable wrapper that binds a field to its sanitizer so call sites do
 * not have to remember which allowlist applies. Strict alphanumeric is the
 * default; specialized fields opt into a permissive allowlist by name.
 *
 * Usage (controlled input):
 *   const clean = useSanitizedInput();
 *   <input value={name} onChange={e => setName(clean(e.target.value, 'text'))} />
 *
 * Usage (bind a whole form):
 *   const { sanitize, bind } = useSanitizedInput();
 *   <input {...bind('email', email, setEmail)} />
 *
 * Every sanitizer strips HTML/script characters first, so no field can carry an
 * injected tag or script payload into state or the DB.
 */
export const useSanitizedInput = () => {
  const sanitize = useCallback((value, fieldType = 'alphaNum') => (
    sanitizeByFieldType(value, fieldType)
  ), []);

  // bind(fieldType, value, setter) -> props for an <input>
  const bind = useCallback((fieldType, value, setter) => ({
    value,
    onChange: (event) => {
      const raw = event?.target ? event.target.value : event;
      setter(sanitize(raw, fieldType));
    },
  }), [sanitize]);

  return { sanitize, bind, fieldTypes: FIELD_SANITIZERS };
};

export default useSanitizedInput;
