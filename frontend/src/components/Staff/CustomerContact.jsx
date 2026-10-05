import React from 'react';
import { User, Phone } from 'lucide-react';

/**
 * Who the technician is serving: the customer's name and a tap-to-call number.
 * Both come from the booking's own copy of the customer's details, which follows
 * the account while the booking is open (so a corrected name or number shows up
 * here without anyone editing the booking).
 */
const CustomerContact = ({ name, phone, compact = false }) => {
  const cleanName = String(name || '').trim();
  const cleanPhone = String(phone || '').trim();
  if (!cleanName && !cleanPhone) return null;

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: compact ? '0.35rem 0.9rem' : '0.5rem 1.1rem', marginTop: '0.35rem', fontSize: compact ? '0.72rem' : '0.78rem', fontWeight: 700, color: 'var(--admin-text-secondary)' }}>
      {cleanName && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', color: 'var(--admin-text-primary)' }}>
          <User size={13} /> {cleanName}
        </span>
      )}
      {cleanPhone && (
        <a href={`tel:${cleanPhone.replace(/[^\d+]/g, '')}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', color: 'var(--admin-brand)', textDecoration: 'none' }}>
          <Phone size={13} /> {cleanPhone}
        </a>
      )}
    </div>
  );
};

export default CustomerContact;
