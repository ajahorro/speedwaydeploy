import React, { useState, useEffect, useRef } from 'react';
import { X, ShieldCheck, Mail, KeyRound, AlertCircle, Loader } from 'lucide-react';
import { requestQrChangeOtp, verifyQrChangeOtp, QR_FIELDS, validateQrRecipients } from '../../services/qrSecurityService';
import toast from 'react-hot-toast';

/**
 * QrChangeOtpModal
 * ============================================================================
 * Batch 7 / Step 7.5 — Task B: 6-digit email OTP verification for QR changes.
 *
 * Two-phase flow:
 *   Phase 1 (MANDATORY FIELDS): the operator fills/edits the four recipient
 *     fields. Save is BLOCKED until every field is present and valid — the
 *     modal shows "All fields are required" rather than a vague failure.
 *   Phase 2 (OTP): clicking "Send Code" emails a 6-digit code; the operator
 *     enters it and only then is the config committed (via verify_qr_change_otp)
 *     with an audit-log entry carrying the Old-vs-New diff.
 *
 * Styling: native tokens only; 375px-safe (single column, no overflow).
 */

const EMPTY = {
  qr_account_name: '',
  qr_account_number: '',
  fallback_receiver_name: '',
  fallback_receiver_number: '',
  payment_qr_url: '',
};

const QrChangeOtpModal = ({ open, currentConfig = {}, onClose, onCommitted }) => {
  const [phase, setPhase] = useState('fields'); // 'fields' | 'otp'
  const [form, setForm] = useState(EMPTY);
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const otpInputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setPhase('fields');
      setOtp('');
      setError('');
      setBusy(false);
      setForm({
        qr_account_name: currentConfig.qr_account_name || '',
        qr_account_number: currentConfig.qr_account_number || '',
        fallback_receiver_name: currentConfig.fallback_receiver_name || '',
        fallback_receiver_number: currentConfig.fallback_receiver_number || '',
        payment_qr_url: currentConfig.payment_qr_url || currentConfig.gcash_qr_url || currentConfig.qr_photo_url || '',
      });
    }
  }, [open, currentConfig]);

  useEffect(() => {
    if (phase === 'otp' && otpInputRef.current) otpInputRef.current.focus();
  }, [phase]);

  if (!open) return null;

  const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));
  const qrFieldList = [...QR_FIELDS, { key: 'payment_qr_url', label: 'QR Photo URL' }];

  const handleSendCode = async () => {
    setError('');
    const v = validateQrRecipients(form);
    if (!v.ok) {
      // Explicit, actionable message — never a silent failure.
      setError('All fields are required');
      toast.error('All fields are required');
      return;
    }
    setBusy(true);
    try {
      await requestQrChangeOtp(form, currentConfig);
      setPhase('otp');
      toast.success('A 6-digit code has been emailed to the administrator.');
    } catch (err) {
      setError(err.message || 'Could not send the verification code.');
      toast.error(err.message || 'Could not send the verification code.');
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async () => {
    setError('');
    if (String(otp).replace(/\D/g, '').length !== 6) {
      setError('Enter the 6-digit code from your email.');
      return;
    }
    setBusy(true);
    try {
      const result = await verifyQrChangeOtp(otp, form);
      toast.success('QR configuration updated.');
      onCommitted?.(result);
      onClose?.();
    } catch (err) {
      setError(err.message || 'Verification failed.');
      toast.error(err.message || 'Verification failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="qr-otp-title"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100000,
        background: 'var(--modal-overlay)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--admin-card)', border: '1px solid var(--admin-border)',
          borderRadius: 'var(--admin-radius-lg, var(--admin-radius))',
          boxShadow: 'var(--modal-shadow)', width: '100%', maxWidth: '500px',
          maxHeight: '92vh', overflowY: 'auto', position: 'relative',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--admin-border)' }}>
          <span style={{ width: '42px', height: '42px', flexShrink: 0, borderRadius: 'var(--admin-radius-sm)', background: 'rgba(var(--admin-brand-rgb), 0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {phase === 'fields' ? <KeyRound size={20} color="var(--admin-brand)" /> : <ShieldCheck size={20} color="var(--status-success)" />}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 id="qr-otp-title" style={{ margin: 0, fontSize: '1.05rem', fontWeight: 950, color: 'var(--admin-text-primary)' }}>
              {phase === 'fields' ? 'Change QR Recipients' : 'Enter Verification Code'}
            </h3>
            <p style={{ margin: '0.15rem 0 0', fontSize: '0.72rem', fontWeight: 700, color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              {phase === 'fields' ? 'Step 1 of 2 · All fields mandatory' : 'Step 2 of 2 · Email OTP'}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', padding: '0.25rem', color: 'var(--admin-text-secondary)', cursor: 'pointer', flexShrink: 0 }}>
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '1.5rem' }}>
          {error && (
            <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', padding: '0.7rem 0.9rem', background: 'rgba(var(--admin-brand-rgb), 0.08)', border: '1px solid var(--status-danger)', borderRadius: 'var(--admin-radius-sm)', color: 'var(--status-danger)', fontSize: '0.8rem', fontWeight: 800 }}>
              <AlertCircle size={16} /> {error}
            </div>
          )}

          {phase === 'fields' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {qrFieldList.map(({ key, label }) => {
                const required = key !== 'payment_qr_url';
                return (
                  <label key={key} style={{ display: 'block' }}>
                    <span style={{ display: 'block', fontSize: '0.7rem', fontWeight: 900, color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '0.35rem' }}>
                      {label}{required ? <span style={{ color: 'var(--status-danger)' }}> *</span> : ''}
                    </span>
                    <input
                      type="text"
                      value={form[key]}
                      onChange={(e) => setField(key, e.target.value)}
                      placeholder={required ? label : 'https://example.com/qr-code.png'}
                      style={{
                        width: '100%', padding: '0.8rem 0.9rem',
                        background: 'var(--admin-input-bg)', color: 'var(--admin-text-primary)',
                        border: '1px solid var(--admin-input-border)',
                        borderRadius: 'var(--admin-radius-sm)', fontSize: '0.9rem', fontWeight: 600, outline: 'none',
                        boxSizing: 'border-box',
                      }}
                    />
                  </label>
                );
              })}
              <p style={{ margin: 0, fontSize: '0.72rem', color: 'var(--admin-text-secondary)', fontWeight: 600, lineHeight: 1.5 }}>
                The four recipient fields are required. The QR photo URL is optional, but if you provide one it is stored with the QR configuration and shown on the payment screen.
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--admin-text-secondary)', fontSize: '0.82rem', fontWeight: 700 }}>
                <Mail size={16} /> A 6-digit code was sent to your email.
              </div>
              <input
                ref={otpInputRef}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="••••••"
                style={{
                  width: '100%', padding: '1rem', textAlign: 'center', letterSpacing: '0.6em',
                  background: 'var(--admin-input-bg)', color: 'var(--admin-text-primary)',
                  border: '1px solid var(--admin-input-border)', borderRadius: 'var(--admin-radius-sm)',
                  fontSize: '1.4rem', fontWeight: 900, outline: 'none', boxSizing: 'border-box',
                }}
              />
              <button type="button" onClick={() => { setPhase('fields'); setError(''); }} style={{ background: 'none', border: 'none', color: 'var(--admin-text-secondary)', fontSize: '0.75rem', fontWeight: 800, cursor: 'pointer', textAlign: 'left', padding: 0 }}>
                ← Edit recipient details
              </button>
            </div>
          )}
        </div>

        {/* Actions */}
        <div style={{ padding: '1rem 1.5rem 1.5rem', borderTop: '1px solid var(--admin-border)', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button type="button" onClick={onClose} style={{ flex: '1 1 120px', minHeight: '2.75rem', padding: '0.85rem 1rem', background: 'var(--admin-bg)', color: 'var(--admin-text-primary)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius-sm)', fontWeight: 950, fontSize: '0.78rem', textTransform: 'uppercase', cursor: 'pointer' }}>
            Cancel
          </button>
          {phase === 'fields' ? (
            <button type="button" onClick={handleSendCode} disabled={busy} style={{ flex: '1 1 160px', minHeight: '2.75rem', padding: '0.85rem 1rem', background: busy ? 'var(--admin-border)' : 'var(--admin-brand)', color: busy ? 'var(--admin-text-secondary)' : 'var(--admin-text-on-brand)', border: '1px solid var(--admin-brand)', borderRadius: 'var(--admin-radius-sm)', fontWeight: 950, fontSize: '0.78rem', textTransform: 'uppercase', cursor: busy ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' }}>
              {busy ? <><Loader size={15} className="spin" /> Sending…</> : 'Send Code'}
            </button>
          ) : (
            <button type="button" onClick={handleVerify} disabled={busy} style={{ flex: '1 1 160px', minHeight: '2.75rem', padding: '0.85rem 1rem', background: busy ? 'var(--admin-border)' : 'var(--status-success)', color: busy ? 'var(--admin-text-secondary)' : 'var(--admin-text-on-status)', border: 'none', borderRadius: 'var(--admin-radius-sm)', fontWeight: 950, fontSize: '0.78rem', textTransform: 'uppercase', cursor: busy ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' }}>
              {busy ? <><Loader size={15} className="spin" /> Verifying…</> : 'Verify & Save'}
            </button>
          )}
        </div>
      </div>

      <style>{`
        @media (max-width: 420px) {
          .qr-otp-actions { flex-direction: column; }
        }
      `}</style>
    </div>
  );
};

export default QrChangeOtpModal;