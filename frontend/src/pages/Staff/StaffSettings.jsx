import React from 'react';
import { BookOpen } from 'lucide-react';
import { useUI } from '../../context/UIContext';
import PageHeader from '../../components/PageHeader';
import { APP_METADATA, SHOP_SOP } from '../../config/legalContent';
import { SettingsSection, SettingRow, SettingButton, SettingTag } from '../../components/Settings/SettingsPrimitives';
import AppPreferencesCard from '../../components/Settings/AppPreferencesCard';
import LegalPoliciesCard from '../../components/Settings/LegalPoliciesCard';
import AppMetadataFooter from '../../components/Settings/AppMetadataFooter';

const StaffSettings = () => {
  const { openModal } = useUI();

  const openSop = () => {
    openModal({
      title: SHOP_SOP.title,
      confirmText: 'Close',
      cancelText: null,
      type: 'info',
      message: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {SHOP_SOP.sections.map((section) => (
            <div key={section.heading}>
              <div style={{ fontSize: '0.8rem', fontWeight: 900, color: 'var(--admin-text-primary)', marginBottom: '0.4rem', textTransform: 'uppercase' }}>
                {section.heading}
              </div>
              {section.paragraphs.map((paragraph, index) => (
                <p key={index} style={{ margin: '0 0 0.5rem', fontSize: '0.82rem', lineHeight: 1.7, color: 'var(--admin-text-secondary)' }}>
                  {paragraph}
                </p>
              ))}
            </div>
          ))}
        </div>
      ),
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', paddingBottom: '4rem' }}>
      <PageHeader
        badge="STAFF WORKSPACE"
        title="Settings"
        subtitle="Choose your interface appearance and access shop resources."
      />

      <AppPreferencesCard role="staff" />

      <SettingsSection title="Work Resources" description="Current operating guidance and application information.">
        <SettingRow
          title="Internal Shop SOP & Guidelines"
          subtitle="Quality-control and bay operating procedures."
          onClick={openSop}
        >
          <SettingButton><BookOpen size={14} /> Read Guidelines</SettingButton>
        </SettingRow>
        <SettingRow title="App Version">
          <SettingTag>v{APP_METADATA.version}-staff</SettingTag>
        </SettingRow>
      </SettingsSection>

      <LegalPoliciesCard />
      <AppMetadataFooter role="staff" />
    </div>
  );
};

export default StaffSettings;
