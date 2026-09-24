import React from 'react';
import { useNavigate } from 'react-router-dom';
import { UserCog } from 'lucide-react';
import AppPreferencesCard from '../../components/Settings/AppPreferencesCard';
import LegalPoliciesCard from '../../components/Settings/LegalPoliciesCard';
import AppMetadataFooter from '../../components/Settings/AppMetadataFooter';
import { SettingsSection, SettingRow, SettingButton } from '../../components/Settings/SettingsPrimitives';

/**
 * CUSTOMER SETTINGS
 *
 * Layout: a single flat container wraps every settings element so the page has
 * UI uniformity (one surface, sharp corners, no nested card boxes). Matches the
 * Admin and Staff settings screens.
 */
const CustomerSettings = () => {
  const navigate = useNavigate();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', paddingBottom: '4rem' }}>
      {/* Header */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 className="text-fluid-h1" style={{ margin: '0 0 0.35rem 0', color: 'var(--admin-text-primary)', textTransform: 'uppercase', letterSpacing: '-1.5px', lineHeight: 1.1 }}>
          Settings
        </h1>
        <p style={{ margin: 0, color: 'var(--admin-text-secondary)', fontSize: '0.85rem', fontWeight: 500 }}>
          Configure your interface preferences and notification behavior.
        </p>
      </div>

      {/* Single container for all settings elements — one unified surface. */}
      <div style={{ background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: 0, padding: '0.5rem 2rem 2rem' }}>
        <AppPreferencesCard role="customer" />

        {/* Account shortcut — profile & security live on the profile page */}
        <SettingsSection title="Account">
          <SettingRow title="Profile & Security" subtitle="Update your personal details, email, and password.">
            <SettingButton onClick={() => navigate('/customer/profile')}>
              <UserCog size={14} /> Open Profile
            </SettingButton>
          </SettingRow>
        </SettingsSection>

        <LegalPoliciesCard />
        <AppMetadataFooter role="customer" />
      </div>
    </div>
  );
};

export default CustomerSettings;