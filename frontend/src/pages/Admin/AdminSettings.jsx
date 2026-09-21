import React, { useState } from 'react';
import { Shield, Key, Moon, Sun, UserCheck, CheckCircle, AlertCircle } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useTheme } from '../../context/ThemeContext';

export default function AdminSettings() {
  const { user, profile, requestPasswordChange } = useAuth();
  const { theme, toggleTheme } = useTheme();

  const [passwordForm, setPasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: ''
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });

  const handlePasswordChange = async (e) => {
    e.preventDefault();
    setMessage({ type: '', text: '' });

    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setMessage({ type: 'error', text: 'New passwords do not match.' });
      return;
    }

    if (passwordForm.newPassword.length < 6) {
      setMessage({ type: 'error', text: 'Password must be at least 6 characters long.' });
      return;
    }

    if (!passwordForm.currentPassword) {
      setMessage({ type: 'error', text: 'Enter your current password to continue.' });
      return;
    }

    try {
      setSaving(true);
      // Secure flow: verifies current password server-side and emails a
      // confirmation link before the change is finalized.
      await requestPasswordChange(passwordForm.currentPassword, passwordForm.newPassword);

      setMessage({ type: 'success', text: 'Confirmation email sent. Approve it to finalize your new password.' });
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
    } catch (err) {
      console.error('Password update error:', err);
      setMessage({ type: 'error', text: err.message || 'Failed to update password.' });
    } finally {
      setSaving(false);
    }
  };

  const inputClass = 'w-full h-9 px-3 text-xs md:text-sm rounded-lg border-[var(--admin-border,#cbd5e1)] dark:border-slate-700 bg-white dark:bg-slate-950 text-[var(--admin-text-primary,#0f172a)] dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500';
  const labelClass = 'block text-xs font-medium text-[var(--admin-text-muted,#64748b)] dark:text-slate-400 mb-1';
  const cardClass = 'bg-[var(--admin-card-bg,#ffffff)] dark:bg-slate-900 border-[var(--admin-border,#e2e8f0)] dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-4';
  const cardHeaderClass = 'flex items-center gap-3 border-b border-[var(--admin-border,#e2e8f0)] dark:border-slate-800 pb-3';
  const cardTitleClass = 'text-base font-semibold text-[var(--admin-text-primary,#0f172a)] dark:text-white';

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-[var(--admin-text-primary,#0f172a)] dark:text-white">
          System Settings
        </h1>
        <p className="text-sm text-[var(--admin-text-muted,#64748b)] dark:text-slate-400">
          Manage administrator credentials, security configurations, and interface preferences.
        </p>
      </div>

      {message.text && (
        <div className={`p-4 rounded-lg flex items-center gap-3 text-sm ${
          message.type === 'error'
            ? 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400 border-red-200 dark:border-red-900'
            : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900'
        }`}>
          {message.type === 'error' ? <AlertCircle className="w-4 h-4" /> : <CheckCircle className="w-4 h-4" />}
          <span>{message.text}</span>
        </div>
      )}

      {/* Admin Account Profile */}
      <div className={cardClass}>
        <div className={cardHeaderClass}>
          <UserCheck className="w-5 h-5 text-red-600" />
          <h2 className={cardTitleClass}>Admin Profile & Identity</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs md:text-sm">
          <div>
            <span className="block text-[var(--admin-text-muted,#64748b)] dark:text-slate-400">Authenticated Email</span>
            <span className="font-medium text-[var(--admin-text-primary,#0f172a)] dark:text-white">
              {user?.email || profile?.email || 'admin@speedway.com'}
            </span>
          </div>
          <div>
            <span className="block text-[var(--admin-text-muted,#64748b)] dark:text-slate-400">Role Privilege</span>
            <span className="inline-block px-2 py-0.5 rounded text-[11px] font-semibold bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-400">
              {(profile?.role || 'ADMIN').toUpperCase() === 'ADMIN' ? 'SYSTEM ADMINISTRATOR' : (profile?.role || '').toUpperCase()}
            </span>
          </div>
        </div>
      </div>

      {/* Theme Preference Settings */}
      <div className={cardClass}>
        <div className={cardHeaderClass}>
          <Shield className="w-5 h-5 text-red-600" />
          <h2 className={cardTitleClass}>Display & Appearance</h2>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-[var(--admin-text-primary,#0f172a)] dark:text-white">Interface Theme Mode</p>
            <p className="text-xs text-[var(--admin-text-muted,#64748b)] dark:text-slate-400">Toggle between Light and Dark display palettes.</p>
          </div>
          <button
            onClick={() => toggleTheme(theme === 'dark' ? 'light' : 'dark')}
            className="flex items-center gap-2 px-3 h-9 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-xs font-medium rounded-lg transition-colors text-[var(--admin-text-primary,#0f172a)] dark:text-white"
          >
            {theme === 'dark' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-slate-600" />}
            <span>{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
          </button>
        </div>
      </div>

      {/* Security & Password Reset */}
      <form onSubmit={handlePasswordChange} className={cardClass}>
        <div className={cardHeaderClass}>
          <Key className="w-5 h-5 text-red-600" />
          <h2 className={cardTitleClass}>Security & Authentication</h2>
        </div>
        <div className="space-y-3">
          <div>
            <label className={labelClass}>Current Password</label>
            <input
              type="password"
              value={passwordForm.currentPassword}
              onChange={(e) => setPasswordForm((prev) => ({ ...prev, currentPassword: e.target.value }))}
              className={inputClass}
              required
            />
          </div>
          <div>
            <label className={labelClass}>New Password</label>
            <input
              type="password"
              value={passwordForm.newPassword}
              onChange={(e) => setPasswordForm((prev) => ({ ...prev, newPassword: e.target.value }))}
              className={inputClass}
              required
            />
          </div>
          <div>
            <label className={labelClass}>Confirm New Password</label>
            <input
              type="password"
              value={passwordForm.confirmPassword}
              onChange={(e) => setPasswordForm((prev) => ({ ...prev, confirmPassword: e.target.value }))}
              className={inputClass}
              required
            />
          </div>
        </div>
        <div className="flex justify-end pt-2">
          <button
            type="submit"
            disabled={saving}
            className="px-4 h-9 bg-red-600 hover:bg-red-700 text-white font-medium text-xs md:text-sm rounded-lg transition-colors disabled:opacity-50"
          >
            {saving ? 'Updating...' : 'Update Password'}
          </button>
        </div>
      </form>
    </div>
  );
}
