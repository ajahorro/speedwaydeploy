/**
 * promoFormTokens.js
 * Shared design tokens for the promo forms. Keeps the "14px bold headers,
 * 12px muted labels, 36px input heights" spec in one place so both standard and
 * package forms stay visually identical without duplicated magic numbers.
 */

export const promoFieldTokens = Object.freeze({
  header: '14px',   // spec: 14px bold section header
  label: '12px',    // spec: 12px medium muted label
  input: '13px',    // spec: 13px regular input text
  inputHeight: '36px', // spec: 36px control height
  // Secondary control text (checkbox rows, bulk action buttons).
  control: '12px',  // spec: 12px for interactive control labels
  controlSm: '11px', // spec: 11px for dense action buttons
});

export const inputStyle = {
  width: '100%',
  boxSizing: 'border-box',
  height: promoFieldTokens.inputHeight,
  minHeight: promoFieldTokens.inputHeight,
  background: 'var(--admin-input-bg)',
  // Theme-driven border so light mode does not render a dark slate edge.
  border: '1px solid var(--admin-input-border)',
  color: 'var(--admin-text-primary)',
  borderRadius: '4px',
  padding: '0 0.9rem',
  fontSize: promoFieldTokens.input,
  fontWeight: 400,
  fontFamily: 'inherit',
};

export const labelStyle = {
  display: 'block',
  marginBottom: '0.45rem',
  fontSize: promoFieldTokens.label,
  fontWeight: 500, // spec: medium weight
  color: 'var(--admin-text-secondary)',
};

export const sectionHeaderStyle = {
  fontSize: promoFieldTokens.header,
  fontWeight: 800,
  color: 'var(--admin-text-primary)',
  marginBottom: '0.85rem',
};
