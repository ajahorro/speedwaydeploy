import React from 'react';

/** "See more" under a list that loads 10 rows at a time. */
const SeeMoreButton = ({ onClick, loading = false }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={loading}
    style={{ justifySelf: 'center', margin: '0.5rem auto', padding: '0.65rem 1.75rem', background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius)', color: 'var(--admin-text-primary)', fontWeight: 900, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '1px', cursor: loading ? 'wait' : 'pointer' }}
  >
    {loading ? 'Loading…' : 'See more'}
  </button>
);

export default SeeMoreButton;
