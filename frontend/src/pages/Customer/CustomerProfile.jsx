import React, { useState, useEffect } from 'react';
import { 
  User, Mail, Phone, Lock, Shield, Trash2, Save, Loader2, 
  Key, AlertTriangle, ChevronRight, CheckCircle, Edit3, X, 
  ShieldCheck, RefreshCw, Send
} from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { supabase } from '../../lib/supabase';
import toast from '@/lib/toast';
import { useConfirmAction } from '../../hooks/useConfirmAction';
import { PhoneInput, EmailInput } from '../../components/common/ContactInputs';
import { phoneError, emailError, normalizePhPhone } from '../../utils/contactValidation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Card } from '@/components/ui/card';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Alert, AlertDescription } from '@/components/ui/alert';

const CustomerProfile = () => {
  const { confirmThen } = useConfirmAction();
  const { user, profile, updateProfile, verifyPassword, requestPasswordChange, resendPasswordChange, requestEmailChange, confirmEmailChange, deactivateAccount } = useAuth();

  // States
  const [isEditing, setIsEditing] = useState(false);
  // Task 16: track confirmation-email delivery so the user can resend if needed.
  const [passwordEmailState, setPasswordEmailState] = useState(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [showPassModal, setShowPassModal] = useState(false);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [showDeactivateModal, setShowDeactivateModal] = useState(false);
  const [passwordInputReady, setPasswordInputReady] = useState(false);

  // Form Data
  const [formData, setFormData] = useState({
    firstName: profile?.first_name || user?.user_metadata?.first_name || '',
    lastName: profile?.last_name || user?.user_metadata?.last_name || '',
    phone: profile?.phone_number || user?.user_metadata?.phone_number || ''
  });

  const [emailData, setEmailData] = useState({
    newEmail: '',
    otp: '',
    step: 1 // 1: Request, 2: Confirm
  });

  const [passwordData, setPasswordData] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: ''
  });

  const [pendingAction, setPendingAction] = useState(null); // 'profile' or 'password'

  const displayName = `${formData.firstName} ${formData.lastName}`.trim() || 'Customer';
  const initials = displayName.split(' ').map(part => part[0]).join('').slice(0, 2).toUpperCase();

  // Reset form when profile loads
  useEffect(() => {
    if (profile || user) {
      setFormData({
        firstName: profile?.first_name || user?.user_metadata?.first_name || '',
        lastName: profile?.last_name || user?.user_metadata?.last_name || '',
        phone: profile?.phone_number || user?.user_metadata?.phone_number || ''
      });
    }
  }, [profile, user]);

  // Password form is valid only when:
  // 1. Current password is filled
  // 2. New password is more than 4 characters
  // 3. Confirm password matches new password
  const isPasswordFormValid =
    passwordData.currentPassword.trim().length > 0 &&
    passwordData.newPassword.length > 4 &&
    passwordData.confirmPassword.length > 0 &&
    passwordData.newPassword === passwordData.confirmPassword;

  const handleSaveProfileClick = (e) => {
    e.preventDefault();
    // Only judge the number when it was changed, so an older stored format never blocks other edits.
    const originalPhone = profile?.phone_number || user?.user_metadata?.phone_number || '';
    if (formData.phone !== originalPhone) {
      const phoneProblem = phoneError(formData.phone, { required: false });
      if (phoneProblem) { toast.error(phoneProblem); return; }
    }
    setPendingAction('profile');
    setPasswordInputReady(false);
    setShowPassModal(true);
  };

  const handleUpdatePasswordClick = async (e) => {
    e.preventDefault();
    if (!passwordData.currentPassword) return toast.error('Current password required');
    if (passwordData.newPassword !== passwordData.confirmPassword) {
      return toast.error('New passwords do not match');
    }
    if (passwordData.newPassword.length <= 4) {
      return toast.error('New password must be more than 4 characters');
    }

    const toastId = toast.loading('Checking your current password...');
    try {
      const isVerified = await verifyPassword(passwordData.currentPassword);
      if (!isVerified.success) {
        toast.error('Verification failed: Incorrect current password', { id: toastId });
        return;
      }

      const changeResult = await requestPasswordChange(passwordData.currentPassword, passwordData.newPassword);

      setPasswordData({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setPasswordEmailState({ delivered: changeResult?.emailDelivered !== false, currentPassword: passwordData.currentPassword });
      if (changeResult?.emailDelivered === false) {
        toast.error('Password change saved, but the confirmation email could not be sent. Use “Resend confirmation email”.', { id: toastId });
      } else {
        toast.success('Check your email to confirm the password change', { id: toastId });
      }
    } catch (error) {
      toast.error(error.message || 'Operation failed', { id: toastId });
    }
  };

  const executeVerifiedAction = async () => {
    const isVerified = await verifyPassword(passwordData.currentPassword);

    if (!isVerified.success) {
      toast.error('Password check failed. Please try again.');
      return;
    }

    setShowPassModal(false);
    const toastId = toast.loading('Saving your changes...');

    try {
      if (pendingAction === 'profile') {
        await updateProfile({
          first_name: formData.firstName,
          last_name: formData.lastName,
          phone_number: formData.phone ? normalizePhPhone(formData.phone) : formData.phone,
          full_name: `${formData.firstName} ${formData.lastName}`.trim()
        });
        setIsEditing(false);
        toast.success('Profile updated', { id: toastId });
      } else if (pendingAction === 'password') {
        const changeResult = await requestPasswordChange(passwordData.currentPassword, passwordData.newPassword);
        setPasswordData({ currentPassword: '', newPassword: '', confirmPassword: '' });
        setPasswordEmailState({ delivered: changeResult?.emailDelivered !== false, currentPassword: passwordData.currentPassword });
        if (changeResult?.emailDelivered === false) {
          toast.error('Password change saved, but the confirmation email could not be sent. Use “Resend confirmation email”.', { id: toastId });
        } else {
          toast.success('Check your email to confirm the password change', { id: toastId });
        }
      }
    } catch (error) {
      toast.error(error.message || 'Operation failed', { id: toastId });
    } finally {
      setPendingAction(null);
    }
  };

  const handleEmailRequest = async (e) => {
    e.preventDefault();
    const emailProblem = emailError(emailData.newEmail);
    if (emailProblem) { toast.error(emailProblem); return; }
    setIsUpdating(true);
    const res = await requestEmailChange(emailData.newEmail);
    setIsUpdating(false);
    if (res.success) {
      setEmailData(prev => ({ ...prev, step: 2 }));
      toast.success('Verification code sent to your current email');
    } else {
      toast.error(res.error || 'Failed to initiate email change');
    }
  };

  const handleEmailConfirm = async (e) => {
    e.preventDefault();
    setIsUpdating(true);
    const res = await confirmEmailChange(emailData.otp);
    setIsUpdating(false);
    if (res.success) {
      setShowEmailModal(false);
      setEmailData({ newEmail: '', otp: '', step: 1 });
      toast.success('Email address updated successfully');
    } else {
      toast.error(res.error || 'Invalid or expired code');
    }
  };

  const handleDeactivate = async () => {
    const res = await deactivateAccount();
    if (res.success) {
      toast.success('Account deactivated. Grace period started.');
    } else {
      toast.error(res.error || 'Deactivation failed');
    }
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

  const fieldClass = 'read-only:cursor-not-allowed read-only:bg-muted/40 read-only:text-muted-foreground';

  return (
    <div className="ui-root flex flex-col gap-8 pb-20">

      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex items-center gap-4">
          <Avatar className="size-14 rounded-md border border-primary/60">
            <AvatarFallback className="rounded-md bg-primary/10 font-bold text-primary">{initials}</AvatarFallback>
          </Avatar>
          <div>
            <h1 className="text-3xl font-black tracking-tight">My Profile</h1>
            <p className="text-sm font-semibold">{displayName}</p>
            <p className="text-xs text-muted-foreground">{user?.email}</p>
            <p className="mt-1 text-sm text-muted-foreground">Manage your personal details, contact info, and account security.</p>
          </div>
        </div>
        {!isEditing && (
          <Button type="button" onClick={() => setIsEditing(true)}><Edit3 /> Edit Profile</Button>
        )}
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-8">

        {/* Left column: personal data */}
        <div className="flex flex-col gap-8">
          <Card className="gap-0 rounded-md p-6">
            <div className="mb-5 flex items-center gap-2">
              <User className="size-5 text-primary" aria-hidden="true" />
              <h2 className="text-base font-semibold">Personal Information</h2>
            </div>

            <form onSubmit={handleSaveProfileClick} className="grid gap-5">
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="profile-first">First Name</Label>
                  <Input id="profile-first" type="text" value={formData.firstName} readOnly={!isEditing} className={fieldClass} onChange={(e) => setFormData({ ...formData, firstName: e.target.value })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="profile-last">Last Name</Label>
                  <Input id="profile-last" type="text" value={formData.lastName} readOnly={!isEditing} className={fieldClass} onChange={(e) => setFormData({ ...formData, lastName: e.target.value })} />
                </div>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="profile-phone">Contact Number</Label>
                <PhoneInput
                  as={Input}
                  id="profile-phone"
                  required={false}
                  value={formData.phone}
                  readOnly={!isEditing}
                  className={fieldClass}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                />
              </div>

              <div className="grid gap-1.5">
                <Label>Email Address</Label>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2.5">
                  <span className="break-all text-sm">{user?.email}</span>
                  <span className="text-[0.65rem] font-bold uppercase text-emerald-600 dark:text-emerald-400">Verified Account</span>
                </div>
                <div>
                  <Button type="button" variant="outline" size="sm" onClick={() => setShowEmailModal(true)}>Change Email Address</Button>
                </div>
              </div>

              {isEditing && (
                <div className="flex justify-end gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => { setIsEditing(false); setFormData({ firstName: profile?.first_name || '', lastName: profile?.last_name || '', phone: profile?.phone_number || '' }); }}
                  >
                    Cancel
                  </Button>
                  <Button type="submit">Save Changes</Button>
                </div>
              )}
            </form>
          </Card>
        </div>

        {/* Right column: security and account actions */}
        <div className="flex flex-col gap-8">

          <Card className="gap-0 rounded-md p-6">
            <div className="mb-5 flex items-center gap-2">
              <Lock className="size-5 text-primary" aria-hidden="true" />
              <h2 className="text-base font-semibold">Password &amp; Security</h2>
            </div>

            <form onSubmit={(e) => { e.preventDefault(); confirmThen({ title: 'Change your password?', message: 'Your password will be updated and other sessions may be signed out.', confirmText: 'Change password' }, () => handleUpdatePasswordClick(e)); }} className="grid gap-4">
              <input
                type="text"
                name="username"
                autoComplete="username"
                defaultValue={profile?.email || user?.email || ''}
                style={{ display: 'none' }}
                tabIndex={-1}
                aria-hidden="true"
              />
              <div className="grid gap-1.5">
                <Label htmlFor="profile-current-password">Current Password</Label>
                <Input
                  id="profile-current-password"
                  type="password"
                  name="verification-password"
                  autoComplete="off"
                  readOnly={!passwordInputReady}
                  onFocus={() => {
                    setPasswordInputReady(true);
                    setPasswordData(prev => ({ ...prev, currentPassword: '' }));
                  }}
                  placeholder="Current password"
                  value={passwordData.currentPassword}
                  onChange={(e) => setPasswordData({ ...passwordData, currentPassword: e.target.value })}
                  required
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="profile-new-password">New Password</Label>
                <Input
                  id="profile-new-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="Min. 6 characters"
                  value={passwordData.newPassword}
                  onChange={(e) => setPasswordData({ ...passwordData, newPassword: e.target.value })}
                />
                {passwordData.newPassword.length > 0 && passwordData.newPassword.length <= 4 && (
                  <p className="text-xs font-medium text-amber-600 dark:text-amber-400">Password must be more than 4 characters</p>
                )}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="profile-confirm-password">Confirm Password</Label>
                <Input
                  id="profile-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="Repeat new password"
                  value={passwordData.confirmPassword}
                  onChange={(e) => setPasswordData({ ...passwordData, confirmPassword: e.target.value })}
                />
                {passwordData.confirmPassword.length > 0 && passwordData.newPassword !== passwordData.confirmPassword && (
                  <p className="text-xs font-medium text-destructive">Passwords do not match</p>
                )}
              </div>
              {/* Confirmation-email delivery status and resend option. */}
              {passwordEmailState && (
                <Alert variant={passwordEmailState.delivered ? 'success' : 'warning'}>
                  <AlertDescription className="flex flex-wrap items-center justify-between gap-3 text-current">
                    <span>
                      {passwordEmailState.delivered
                        ? 'Confirmation email sent. Check your inbox (and spam) to complete the change.'
                        : 'The confirmation email could not be confirmed as sent. Resend it below.'}
                    </span>
                    <Button type="button" variant="outline" size="sm" onClick={handleResendPasswordEmail}>Resend confirmation email</Button>
                  </AlertDescription>
                </Alert>
              )}
              <Button type="submit" disabled={!isPasswordFormValid} className="w-full">Update Password</Button>
            </form>
          </Card>

          <Card className="gap-0 rounded-md border-destructive/30 p-6">
            <div className="mb-3 flex items-center gap-2 text-destructive">
              <AlertTriangle className="size-5" aria-hidden="true" />
              <h2 className="text-base font-semibold">Account Actions</h2>
            </div>
            <p className="mb-5 text-sm text-muted-foreground">
              Account deactivation initiates a 15-day grace period. After 15 days, your account and personal details are permanently deleted. The shop keeps your booking and payment records.
            </p>
            <Button type="button" variant="outline" onClick={() => setShowDeactivateModal(true)} className="w-full border-destructive/50 text-destructive hover:text-destructive">Deactivate Account</Button>
          </Card>
        </div>
      </div>

      {/* --- DIALOGS --- */}

      {/* Password Challenge */}
      <Dialog open={showPassModal} onOpenChange={(open) => { if (!open) { setShowPassModal(false); setPasswordData({ ...passwordData, currentPassword: '' }); } }}>
        <DialogContent className="ui-root sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Shield className="size-5 text-primary" aria-hidden="true" />Confirm Your Identity</DialogTitle>
            <DialogDescription>Enter your current password to confirm this change.</DialogDescription>
          </DialogHeader>
          <Input
            type="password"
            name="verification-password-modal"
            autoComplete="off"
            readOnly={!passwordInputReady}
            onFocus={() => {
              setPasswordInputReady(true);
              setPasswordData(prev => ({ ...prev, currentPassword: '' }));
            }}
            placeholder="Current Password"
            value={passwordData.currentPassword}
            onChange={(e) => setPasswordData({ ...passwordData, currentPassword: e.target.value })}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowPassModal(false); setPasswordData({ ...passwordData, currentPassword: '' }); }}>Cancel</Button>
            <Button onClick={executeVerifiedAction}>Verify &amp; Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Email Change */}
      <Dialog open={showEmailModal} onOpenChange={setShowEmailModal}>
        <DialogContent className="ui-root sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Update Email</DialogTitle>
            <DialogDescription>
              {emailData.step === 1
                ? <>A verification code will be sent to <strong>{user.email}</strong> to authorize this change.</>
                : 'Code sent! Check your inbox for the authorization code.'}
            </DialogDescription>
          </DialogHeader>

          {emailData.step === 1 ? (
            <form onSubmit={handleEmailRequest} className="grid gap-4">
              <div className="grid gap-1.5">
                <Label>New Email Address</Label>
                <EmailInput
                  as={Input}
                  value={emailData.newEmail}
                  onChange={(e) => setEmailData({ ...emailData, newEmail: e.target.value })}
                />
              </div>
              <Button type="submit" disabled={isUpdating}>
                {isUpdating ? <Loader2 className="animate-spin" /> : <Send />}
                Send Authorization Code
              </Button>
            </form>
          ) : (
            <form onSubmit={handleEmailConfirm} className="grid gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="email-otp">Authorization Code</Label>
                <Input
                  id="email-otp"
                  type="text"
                  required
                  placeholder="6-digit code"
                  value={emailData.otp}
                  onChange={(e) => setEmailData({ ...emailData, otp: e.target.value })}
                  className="h-12 text-center text-xl tracking-[0.5em]"
                />
              </div>
              <Button type="submit" disabled={isUpdating}>
                {isUpdating ? <Loader2 className="animate-spin" /> : 'Confirm Change'}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setEmailData({ ...emailData, step: 1 })}>Didn't receive code? Try again</Button>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* Deactivation Confirmation */}
      <AlertDialog open={showDeactivateModal} onOpenChange={setShowDeactivateModal}>
        <AlertDialogContent className="ui-root">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive"><AlertTriangle className="size-5" aria-hidden="true" />Confirm Account Deactivation</AlertDialogTitle>
            <AlertDialogDescription>
              This will log you out immediately. You will have 15 days to recover your account by logging back in. After that, your account is permanently deleted. The shop keeps your booking and payment records.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={handleDeactivate}>Yes, Deactivate</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
};

export default CustomerProfile;
