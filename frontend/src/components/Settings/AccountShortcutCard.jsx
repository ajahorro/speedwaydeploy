import { useNavigate } from 'react-router-dom';
import { UserCog } from 'lucide-react';
import { SettingsSection, SettingRow, SettingButton } from './SettingsPrimitives';

/** Settings › Account: the same shortcut to the profile page for every role (name, contact details, password). */
export default function AccountShortcutCard({ role = 'customer' }) {
  const navigate = useNavigate();
  return (
    <SettingsSection title="Account">
      <SettingRow title="Profile & Password" subtitle="Update your personal details and change your password.">
        <SettingButton onClick={() => navigate(`/${role}/profile`)}>
          <UserCog size={14} /> Open Profile
        </SettingButton>
      </SettingRow>
    </SettingsSection>
  );
}
