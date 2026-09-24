import React, { useEffect, useState } from 'react';
import { Monitor, Moon, Sun, Fingerprint, KeyRound, Lock, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../../hooks/useAuth';
import { useTheme } from '../../context/ThemeContext';
import { useUI } from '../../context/UIContext';
import { loadPreferences, savePreferences } from '../../utils/preferenceStore';
import { SHOP_SOP, APP_METADATA } from '../../config/legalContent';
import {
  SettingsSection, SettingRow, ToggleSwitch, SegmentedControl, SettingButton, SettingTag, SettingField,
} from '../../components/Settings/SettingsPrimitives';
import LegalPoliciesCard from '../../components/Settings/LegalPoliciesCard';
import AppPreferencesCard from '../../components/Settings/AppPreferencesCard';
import AppMetadataFooter from '../../components/Settings/AppMetadataFooter';

/**
 * STAFF ACCOUNT SETTINGS
 * Flat, line-divided layout (no nested card boxes) shared with the Admin and
 * Customer settings screens via SettingsPrimitives.
 *
 * Sections:
 *   1. Profile & Employee Info
 *   2. Shift & Job Notifications
 *   3. Workstation Preferences
 *   4. Security & Credentials (OTP-confirmed password change)
 *   5. Support & Guidelines
 */

const THEME_OPTIONS = [
  { value: 'dark', label: 'Dark Mode', icon: Moon },
  { value: 'light', label: 'Light Mode', icon: Sun },
  { value: 'system', label: 'System Default', icon: Monitor },
];

const LANDING_OPTIONS = [
  { value: 'assigned', label: 'My Assigned Jobs' },
  { value: 'all', label: 'All Bay Jobs' },
];

// Stable, human-readable staff ID derived from the auth UUID (no extra column).
const deriveStaffId = (id) => (id ? `#ST-${String(id).replace(/-/g, '').slice(0, 4).toUpperCase()}` : '#ST-XXXX');

const StaffSettings = () => {
  const { user, profile, requestPasswordChange, resendPasswordChange } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { openModal } = useUI();
  const userId = user?.id || profile?.id;

  const [prefs, setPrefs] = useState(null);
  const [savingKey, setSavingKey] = useState(null);
  const [loading, setLoading] = useState(true);

  // Password change state (section 4).
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passLoading, setPassLoading] = useState(false);
  const [passwordEmailState, setPasswordEmailState] = useState(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const loaded = await loadPreferences(userId);
      if (mounted) {
        setPrefs(loaded);
        setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [userId]);

  const prefValue = (key, fallback) => (prefs && prefs[key] !== undefined ? prefs[key] : fallback);

  const persistPref = async (key, value, label) => {
    if (savingKey) return;
    const next = { ...(prefs || {}), [key]: value };
    setPrefs(next); // optimistic
    setSavingKey(key);
    const result = await savePreferences(userId, next);
    setSavingKey(null);
    if (!result.success) {
      setPrefs(prefs);
      toast.error('Failed to save preference.');
      return;
    }
    if (label) toast.success(`${label} updated`);
    if (result.persisted === false) {
      toast('Saved on this device. Account sync unavailable.', { icon: 'ℹ️' });
    }
  };

  const fullName = profile?.full_name || [profile?.first_name, profile?.last_name].filter(Boolean).join(' ') || user?.email || 'Staff Member';
  const staffId = deriveStaffId(userId);

  const isPasswordFormValid =
    currentPassword.trim().length > 0 && newPassword.length > 4 && confirmPassword === newPassword;

  const handleUpdatePassword = async (e) => {
    e.preventDefault();
    if (!isPasswordFormValid) return;
    setPassLoading(true);
    try {
      const changeResult = await requestPasswordChange(currentPassword, newPassword);
      setPasswordEmailState({ delivered: changeResult?.emailDelivered !== false, currentPassword });
      if (changeResult?.emailDelivered === false) {
        toast.error('Check your email could not be confirmed. Use “Resend email” below.');
      } else {
        toast.success('Confirmation email sent. Check your inbox to finish the change.');
      }
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      toast.error(err.message || 'Failed to update credentials');
    } finally {
      setPassLoading(false);
    }
  };

  const handleResendPasswordEmail = async () => {
    if (!passwordEmailState?.currentPassword) {
      return toast.error('Please submit the password change again to resend the email.');
    }
    const toastId = toast.loading('Resending confirmation email...');
    try {
      const result = await resendPasswordChange(passwordEmailState.currentPassword);
      if (result?.emailDelivered === false) {
        toast.error('The confirmation email still could not be sent.', { id: toastId });
      } else {
        setPasswordEmailState((prev) => ({ ...prev, delivered: true }));
        toast.success('Confirmation email resent. Please check your inbox.', { id: toastId });
      }
    } catch (err) {
      toast.error(err.message || 'Unable to resend the confirmation email.', { id: toastId });
    }
  };

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
              <div style={{ fontSize: '0.8rem', fontWeight: 900, color: 'var(--admin-text-primary)', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {section.heading}
              </div>
              {section.paragraphs.map((p, i) => (
                <p key={i} style={{ margin: '0 0 0.5rem', fontSize: '0.82rem', lineHeight: 1.7, color: 'var(--admin-text-secondary)', fontWeight: 500 }}>
                  {p}
                </p>
              ))}
            </div>
          ))}
        </div>
      ),
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', paddingBottom: '4rem' }}>
      {/* Header */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 className="text-fluid-h1" style={{ margin: '0 0 0.35rem 0', color: 'var(--admin-text-primary)', textTransform: 'uppercase', letterSpacing: '-1.5px', lineHeight: 1.1 }}>
          Settings
        </h1>
        <p style={{ margin: 0, color: 'var(--admin-text-secondary)', fontSize: '0.85rem', fontWeight: 500 }}>
          Manage your profile, workstation, notifications, and security.
        </p>
      </div>

      {/* Single container for all settings elements — one unified surface. */}
      <div style={{ background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: 0, padding: '0.5rem 2rem 2rem' }}>

      {/* ── Section 1: Profile & Employee Info ───────────────────────────── */}
      <SettingsSection title="Profile & Employee Info">
        <SettingRow title="Full Name" subtitle="Shown on job cards and shift rosters.">
          <span style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--admin-text-primary)' }}>{fullName}</span>
        </SettingRow>
        <SettingRow title="Work Email" subtitle="Used for shift and job notifications.">
          <SettingField value={user?.email || profile?.email || '—'} readOnly type="email" />
        </SettingRow>
        <SettingRow title="Mobile Number" subtitle="Primary contact for urgent shift changes.">
          <SettingField value={profile?.phone_number || profile?.contact_number || ''} readOnly placeholder="Not set" />
        </SettingRow>
        <SettingRow title="Staff Designation" subtitle="Your role and unique employee reference.">
          <SettingTag tone="brand">
            <Fingerprint size={12} /> Lead Detailer · ID: {staffId}
          </SettingTag>
        </SettingRow>
      </SettingsSection>

      {/* ── Section 2: Shift & Job Notifications ─────────────────────────── */}
      <SettingsSection title="Shift & Job Notifications">
        <SettingRow title="Job Assignment Alerts" subtitle="Alert when a vehicle is assigned to your bay.">
          <ToggleSwitch
            checked={Boolean(prefValue('jobAssignmentAlerts', true))}
            loading={savingKey === 'jobAssignmentAlerts'}
            disabled={loading}
            label="Job Assignment Alerts"
            onChange={(v) => persistPref('jobAssignmentAlerts', v, 'Job assignment alerts')}
          />
        </SettingRow>
        <SettingRow title="Schedule & Roster Changes" subtitle="Alert when shift hours change.">
          <ToggleSwitch
            checked={Boolean(prefValue('scheduleRosterChanges', true))}
            loading={savingKey === 'scheduleRosterChanges'}
            disabled={loading}
            label="Schedule & Roster Changes"
            onChange={(v) => persistPref('scheduleRosterChanges', v, 'Roster alerts')}
          />
        </SettingRow>
        <SettingRow title="Sound & Haptic Chime" subtitle="Audio chime on new job queue.">
          <ToggleSwitch
            checked={Boolean(prefValue('soundHapticChime', false))}
            loading={savingKey === 'soundHapticChime'}
            disabled={loading}
            label="Sound & Haptic Chime"
            onChange={(v) => persistPref('soundHapticChime', v, 'Job queue chime')}
          />
        </SettingRow>
      </SettingsSection>

      {/* ── Section 3: Workstation Preferences ───────────────────────────── */}
      <SettingsSection title="Workstation Preferences">
        <SettingRow title="Default Landing View" subtitle="Which job board opens first when you sign in.">
          <SegmentedControl
            options={LANDING_OPTIONS}
            value={prefValue('staffLandingView', 'assigned')}
            onChange={(v) => persistPref('staffLandingView', v, 'Default landing view')}
            ariaLabel="Default landing view"
          />
        </SettingRow>
        <SettingRow title="Interface Theme" subtitle="Personal appearance for your workstation.">
          <SegmentedControl
            options={THEME_OPTIONS}
            value={theme}
            onChange={toggleTheme}
            ariaLabel="Interface theme"
          />
        </SettingRow>
      </SettingsSection>

      {/* ── Section 4: Security & Credentials ────────────────────────────── */}
      <SettingsSection title="Security & Credentials" description="Changing your password sends a one-time confirmation link to your email. The password only updates after you open that link.">
        <form onSubmit={handleUpdatePassword} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', paddingTop: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
            <div style={{ minWidth: '12rem' }}>
              <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--admin-text-primary)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Lock size={15} /> Current Password
              </div>
            </div>
            <input
              type="password"
              autoComplete="off"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Verify identity"
              style={{ width: 'min(100%, 320px)', padding: '0.6rem 0.85rem', background: 'var(--admin-input-bg)', border: '1px solid var(--admin-border)', borderRadius: '8px', color: 'var(--admin-text-primary)', fontSize: '0.85rem', fontWeight: 600, outline: 'none' }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
            <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--admin-text-primary)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <KeyRound size={15} /> New Password
            </div>
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Min. 6 characters"
              style={{ width: 'min(100%, 320px)', padding: '0.6rem 0.85rem', background: 'var(--admin-input-bg)', border: '1px solid var(--admin-border)', borderRadius: '8px', color: 'var(--admin-text-primary)', fontSize: '0.85rem', fontWeight: 600, outline: 'none' }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
            <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--admin-text-primary)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Lock size={15} /> Confirm New Password
            </div>
            <input
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Repeat new password"
              style={{ width: 'min(100%, 320px)', padding: '0.6rem 0.85rem', background: 'var(--admin-input-bg)', border: '1px solid var(--admin-border)', borderRadius: '8px', color: 'var(--admin-text-primary)', fontSize: '0.85rem', fontWeight: 600, outline: 'none' }}
            />
          </div>

          {newPassword.length > 0 && newPassword.length <= 4 && (
            <div style={{ fontSize: '0.72rem', color: 'var(--status-warning)', fontWeight: 700 }}>⚠ Password must be more than 4 characters</div>
          )}
          {confirmPassword.length > 0 && newPassword !== confirmPassword && (
            <div style={{ fontSize: '0.72rem', color: 'var(--status-danger)', fontWeight: 700 }}>✕ Passwords do not match</div>
          )}

          {passwordEmailState && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', padding: '0.85rem 1rem', background: passwordEmailState.delivered ? 'rgba(var(--admin-success-rgb), 0.08)' : 'rgba(245, 158, 11, 0.1)', border: `1px solid ${passwordEmailState.delivered ? 'var(--admin-success)' : 'var(--status-warning)'}`, borderRadius: '8px' }}>
              <span style={{ fontSize: '0.72rem', fontWeight: 700, color: passwordEmailState.delivered ? 'var(--admin-success)' : 'var(--status-warning)' }}>
                {passwordEmailState.delivered
                  ? 'Confirmation email sent. Open it to complete the change.'
                  : 'The confirmation email could not be confirmed as sent.'}
              </span>
              <SettingButton onClick={handleResendPasswordEmail}>
                <RefreshCw size={13} /> Resend email
              </SettingButton>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '0.25rem' }}>
            <SettingButton type="submit" variant="primary" disabled={!isPasswordFormValid || passLoading}>
              <KeyRound size={14} /> {passLoading ? 'Sending…' : 'Update Password'}
            </SettingButton>
          </div>
        </form>
      </SettingsSection>

      {/* ── Section 5: Support & Guidelines ──────────────────────────────── */}
      <SettingsSection title="Support & Guidelines">
        <SettingRow
          title="Internal Shop SOP & Guidelines"
          subtitle="Quality-control and bay operating procedures."
          onClick={openSop}
        >
          <SettingButton>Read Guidelines</SettingButton>
        </SettingRow>
        <SettingRow title="App Version">
          <SettingTag>v{APP_METADATA.version}-staff</SettingTag>
        </SettingRow>
      </SettingsSection>

      {/* ── Shared: App preferences, legal, footer ───────────────────────── */}
      <AppPreferencesCard role="staff" />
      <LegalPoliciesCard />
      <AppMetadataFooter role="staff" faqPath="/#faq" />

      </div>
    </div>
  );
};

export default StaffSettings;