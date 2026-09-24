import React from 'react';
import AppPreferencesCard from '../../components/Settings/AppPreferencesCard';
import LegalPoliciesCard from '../../components/Settings/LegalPoliciesCard';
import AppMetadataFooter from '../../components/Settings/AppMetadataFooter';

/**
 * ADMIN SETTINGS
 *
 * Layout: a single flat container wraps every settings element so the page has
 * UI uniformity (one surface, sharp corners, no nested card boxes). Matches the
 * Staff and Customer settings screens.
 *
 * Tier 2.10 / 2.11 — SINGLE SOURCE OF TRUTH.
 * Business identity, hours, capacity, the service catalog, FAQs, and the
 * QR/GCash payment recipients are ALL owned by the Business Hub (/admin/business).
 */
const AdminSettings = () => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', paddingBottom: '4rem' }}>
      {/* Header */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 className="text-fluid-h1" style={{ margin: '0 0 0.35rem 0', color: 'var(--admin-text-primary)', textTransform: 'uppercase', letterSpacing: '-1.5px', lineHeight: 1.1 }}>
          Settings
        </h1>
        <p style={{ margin: 0, color: 'var(--admin-text-secondary)', fontSize: '0.85rem', fontWeight: 500 }}>
          Your personal app preferences, legal policies, and support options.
        </p>
      </div>

      {/* Single container for all settings elements — one unified surface. */}
      <div style={{ background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: 0, padding: '0.5rem 2rem 2rem' }}>
        <AppPreferencesCard role="admin" />
        <LegalPoliciesCard />
        <AppMetadataFooter role="admin" />
      </div>
    </div>
  );
};

export default AdminSettings;