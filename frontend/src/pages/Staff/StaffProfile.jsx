import React, { useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { supabase } from '../../lib/supabase';
import { User, Mail, Phone, Shield, Key, Save, Loader2, UserCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import PageHeader from '../../components/PageHeader';

const StaffProfile = () => {
  const { profile, user, verifyPassword, requestPasswordChange, resendPasswordChange } = useAuth();
  const [loading, setLoading] = useState(false);
  const [passLoading, setPassLoading] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  // Task 16: track confirmation-email delivery so the user can resend if needed.
  const [passwordEmailState, setPasswordEmailState] = useState(null);

  const isFormValid = currentPassword.trim().length > 0 && newPassword.length > 4 && confirmPassword === newPassword;

  const handleUpdatePassword = async (e) => {
    e.preventDefault();
    if (!isFormValid) return;
    if (!currentPassword) return toast.error('Please enter your current password');
    if (newPassword.length <= 4) return toast.error('New password must be more than 4 characters');
    if (newPassword !== confirmPassword) return toast.error('New passwords do not match');

    setPassLoading(true);
    try {
      // 🛡️ Verify Current Password first
      const verification = await verifyPassword(currentPassword);
      if (!verification.success) {
        throw new Error('Identity verification failed. Incorrect current password.');
      }

      const changeResult = await requestPasswordChange(currentPassword, newPassword);

      setPasswordEmailState({ delivered: changeResult?.emailDelivered !== false, currentPassword });
      if (changeResult?.emailDelivered === false) {
        toast.error('Password change saved, but the confirmation email could not be sent. Use “Resend confirmation email”.');
      } else {
        toast.success('Check your email to confirm the password change');
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

  const cardStyle = {
    background: 'var(--admin-card)',
    border: '1px solid var(--admin-border)',
    borderRadius: '8px',
    padding: '2rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '1.5rem'
  };

  // Task 16: resend the password-change confirmation without retyping fields.
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

  const labelStyle = {
    fontSize: '0.65rem',
    fontWeight: '950',
    color: 'var(--admin-text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '1px',
    marginBottom: '0.5rem'
  };

  const inputStyle = {
    width: '100%',
    background: 'var(--admin-bg)',
    border: '1px solid var(--admin-border)',
    borderRadius: '4px',
    padding: '0.85rem 1rem',
    color: 'var(--admin-text-primary)',
    fontSize: '0.9rem',
    fontWeight: '600',
    outline: 'none'
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2.5rem', maxWidth: '800px' }}>
      <PageHeader
        badge="ACCOUNT SETTINGS"
        title="Technician Profile"
        subtitle="Manage your identity, credentials, and account security settings."
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '2rem' }}>

        {/* Identity Section */}
        <section style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '1.5rem' }}>
            <div style={{ width: '64px', height: '64px', borderRadius: '8px', background: 'var(--admin-brand)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <UserCircle size={40} color="white" />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: '950', textTransform: 'uppercase' }}>{profile?.full_name}</h3>
              <div style={{ fontSize: '0.75rem', color: 'var(--admin-text-secondary)', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '1px' }}>
                Employee ID: SW-{profile?.id?.slice(0, 8).toUpperCase()}
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
            <div>
              <div style={labelStyle}>Primary Email</div>
              <div style={{ ...inputStyle, opacity: 0.6, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <Mail size={16} /> {profile?.email || user?.email}
              </div>
            </div>
            <div>
              <div style={labelStyle}>Phone Number</div>
              <div style={{ ...inputStyle, opacity: 0.6, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <Phone size={16} /> {profile?.phone_number || 'Not Linked'}
              </div>
            </div>
            <div>
              <div style={labelStyle}>Access Role</div>
              <div style={{ ...inputStyle, opacity: 0.6, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <Shield size={16} color="var(--admin-brand)" /> {profile?.role || 'TECHNICIAN'}
              </div>
            </div>
            <div>
              <div style={labelStyle}>Account Status</div>
              <div style={{ ...inputStyle, opacity: 0.6, color: 'var(--status-success)', fontWeight: '950' }}>
                ACTIVE & VERIFIED
              </div>
            </div>
          </div>
        </section>

        {/* Security Section */}
        <section style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Key size={20} color="var(--admin-brand)" />
            <h3 style={{ margin: 0, fontSize: '0.85rem', fontWeight: '950', textTransform: 'uppercase', letterSpacing: '1px' }}>Security Credentials</h3>
          </div>

          <form onSubmit={handleUpdatePassword} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <input
              type="text"
              name="username"
              autoComplete="username"
              defaultValue={profile?.email || user?.email || ''}
              style={{ display: 'none' }}
              tabIndex={-1}
              aria-hidden="true"
            />
            <div>
              <div style={{ marginBottom: '0.5rem' }}>
                <div style={labelStyle}>Current Password</div>
              </div>
              <input
                type="password"
                value={currentPassword}
                onFocus={() => setCurrentPassword('')}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Verify identity"
                style={inputStyle}
                autoComplete="off"
                required
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
              <div>
                <div style={labelStyle}>New Password</div>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Min. 5 characters"
                  style={inputStyle}
                  autoComplete="new-password"
                  required
                />
              </div>
              <div>
                <div style={labelStyle}>Confirm New Password</div>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Repeat new password"
                  style={inputStyle}
                  autoComplete="new-password"
                  required
                />
              </div>
            </div>

            {/* Inline validation hints */}
            {newPassword.length > 0 && newPassword.length <= 4 && (
              <div style={{ fontSize: '0.72rem', color: 'var(--status-warning)', fontWeight: '700', marginTop: '-0.5rem' }}>
                ⚠ Password must be more than 4 characters
              </div>
            )}
            {confirmPassword.length > 0 && newPassword !== confirmPassword && (
              <div style={{ fontSize: '0.72rem', color: 'var(--status-danger)', fontWeight: '700', marginTop: '-0.5rem' }}>
                ✕ Passwords do not match
              </div>
            )}
            {/* Task 16: confirmation-email delivery status + resend option. */}
            {passwordEmailState && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', padding: '0.85rem 1rem', background: passwordEmailState.delivered ? 'rgba(var(--admin-success-rgb), 0.08)' : 'rgba(245, 158, 11, 0.1)', border: `1px solid ${passwordEmailState.delivered ? 'var(--admin-success)' : 'var(--status-warning)'}`, borderRadius: '4px' }}>
                <span style={{ fontSize: '0.72rem', fontWeight: '700', color: passwordEmailState.delivered ? 'var(--admin-success)' : 'var(--status-warning)' }}>
                  {passwordEmailState.delivered
                    ? 'Confirmation email sent. Check your inbox (and spam) to complete the change.'
                    : 'The confirmation email could not be confirmed as sent. Resend it below.'}
                </span>
                <button
                  type="button"
                  onClick={handleResendPasswordEmail}
                  style={{ padding: '0.5rem 0.9rem', background: 'transparent', border: '1px solid var(--admin-border)', color: 'var(--admin-text-primary)', borderRadius: '4px', fontSize: '0.65rem', fontWeight: '900', cursor: 'pointer', whiteSpace: 'nowrap', textTransform: 'uppercase' }}
                >
                  Resend confirmation email
                </button>
              </div>
            )}
            <button 
              type="submit"
              disabled={passLoading || !isFormValid}
              style={{ 
                alignSelf: 'flex-start',
                padding: '0.85rem 2rem', 
                background: (!isFormValid || passLoading) ? 'rgba(230, 30, 42, 0.35)' : '#E61E2A', 
                color: (!isFormValid || passLoading) ? 'rgba(255, 255, 255, 0.4)' : 'white', 
                border: 'none', borderRadius: '4px', 
                fontWeight: '950', fontSize: '0.8rem', 
                cursor: (!isFormValid || passLoading) ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', gap: '0.75rem',
                textTransform: 'uppercase', letterSpacing: '1px',
                transition: 'all 0.2s ease',
                opacity: (!isFormValid || passLoading) ? 0.6 : 1
              }}
            >
              {passLoading ? <Loader2 className="animate-spin" size={18} /> : <Save size={18} />}
              Update Credentials
            </button>
          </form>
        </section>
      </div>
    </div>
  );
};

export default StaffProfile;
