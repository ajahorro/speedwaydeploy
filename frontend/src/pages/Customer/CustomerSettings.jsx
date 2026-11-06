import React from 'react';
import AccountShortcutCard from '../../components/Settings/AccountShortcutCard';
import AppPreferencesCard from '../../components/Settings/AppPreferencesCard';
import LegalPoliciesCard from '../../components/Settings/LegalPoliciesCard';
import AppMetadataFooter from '../../components/Settings/AppMetadataFooter';
import { TourLauncher } from '../../components/common/GuidedTour';
import { CUSTOMER_TOURS } from '../../features/tours/customerTours';

/**
 * CUSTOMER SETTINGS
 *
 * Layout: a single flat container wraps every settings element so the page has
 * UI uniformity (one surface, sharp corners, no nested card boxes). Matches the
 * Admin and Staff settings screens.
 */
const CustomerSettings = () => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', paddingBottom: '4rem' }}>
      {/* Header */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 className="text-fluid-h1" style={{ margin: '0 0 0.35rem 0', color: 'var(--admin-text-primary)', textTransform: 'uppercase', letterSpacing: '-1.5px', lineHeight: 1.1 }}>
          Settings
        </h1>
        <p style={{ margin: 0, color: 'var(--admin-text-secondary)', fontSize: '0.85rem', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          Language, look, emails and alerts.
          <TourLauncher steps={CUSTOMER_TOURS.settings} label="How Settings works" />
        </p>
      </div>

      {/* Single container for all settings elements — one unified surface. */}
      <div style={{ background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: 0, padding: '0.5rem clamp(1rem, 4vw, 2rem) 2rem' }}>
        <div data-tour="cset-prefs"><AppPreferencesCard role="customer" /></div>

        {/* Account shortcut — profile & security live on the profile page */}
        <div data-tour="cset-account"><AccountShortcutCard role="customer" /></div>

        <div data-tour="cset-legal"><LegalPoliciesCard /></div>
        <AppMetadataFooter role="customer" />
      </div>
    </div>
  );
};

export default CustomerSettings;