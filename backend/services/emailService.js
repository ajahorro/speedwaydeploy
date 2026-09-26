const { Resend } = require('resend');
// ONE resolver for the public frontend URL. Falling back to localhost:5173 here
// meant a deployed site emailed customers a link to their own machine whenever
// FRONTEND_URL was unset — indistinguishable from a broken link.
const { appUrl } = require('./appUrl');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const SENDER_EMAIL = process.env.RESEND_SENDER_EMAIL || process.env.RESEND_FROM || 'Comar Garage <bookings@yourdomain.com>';

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

const buildEmailShell = ({ title, eyebrow = 'COMAR GARAGE', bodyHtml, ctaLink, ctaLabel, footerNote = 'Comar Garage | 39 Hunters ROTC, Barangay San Juan, Cainta, 1900 Rizal' }) => `
  <div style="margin: 0; padding: 0; background: #f5f5f3; font-family: Arial, Helvetica, sans-serif; color: #171717;">
    <div style="max-width: 640px; margin: 0 auto; padding: 24px 16px;">
      <div style="background: linear-gradient(135deg, #111827 0%, #1f2937 100%); border: 1px solid #d4d4d4; border-radius: 18px; overflow: hidden;">
        <div style="padding: 22px 24px 14px; background: linear-gradient(135deg, rgba(169,27,24,0.12), rgba(17,24,39,0.05)); border-bottom: 1px solid rgba(255,255,255,0.12);">
          <div style="font-size: 11px; letter-spacing: 2px; font-weight: 800; color: #fca5a5; text-transform: uppercase; margin-bottom: 8px;">${escapeHtml(eyebrow)}</div>
          <div style="font-size: 28px; line-height: 1.2; font-weight: 900; color: #f5f5f4; margin: 0;">${escapeHtml(title)}</div>
        </div>
        <div style="padding: 24px; background: #ffffff; color: #171717;">
          ${bodyHtml}
          ${ctaLink ? `<div style="text-align: center; margin: 28px 0 8px;"><a href="${escapeHtml(ctaLink)}" style="display: inline-block; background: #a91b18; color: #ffffff; text-decoration: none; padding: 14px 22px; border-radius: 999px; font-weight: 900; font-size: 12px; letter-spacing: 1px; text-transform: uppercase;">${escapeHtml(ctaLabel)}</a></div>` : ''}
        </div>
        <div style="padding: 18px 24px 26px; background: #f9fafb; color: #52525b; border-top: 1px solid #e5e7eb; font-size: 11px; line-height: 1.6; text-align: center;">
          ${escapeHtml(footerNote)}
        </div>
      </div>
    </div>
    <style>
      @media (max-width: 600px) {
        .email-shell { padding: 12px !important; }
      }
      @media (prefers-color-scheme: dark) {
        body { background: #111827 !important; }
      }
    </style>
  </div>
`;

const send = async ({ to, subject, html, attachments }) => {
  if (!resend) return { success: false, error: 'RESEND_API_KEY is not configured' };
  try {
    console.log(`[Email] Sending "${subject}" to ${to}`);
    const { data, error } = await resend.emails.send({
      from: SENDER_EMAIL,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      ...(attachments?.length ? { attachments } : {})
    });
    if (error) {
      const detail = error.statusCode === 401 || /invalid.*api.?key/i.test(error.message || '')
        ? 'RESEND_API_KEY is invalid or expired — copies of invitation/receipt emails cannot be delivered until it is rotated.'
        : (error.message || JSON.stringify(error));
      console.error(`[Email] Resend rejected message: ${detail}`);
      return { success: false, error: detail };
    }
    console.log(`[Email] Sent successfully: ${data?.id || subject}`);
    return { success: true, data };
  } catch (error) {
    console.error('[EmailService] Delivery failed:', error.message);
    return { success: false, error: error.message };
  }
};

const sendBookingConfirmationEmail = async ({ customerEmail, customerName, bookingId, serviceName, scheduledAt, totalAmount }) => send({
  to: customerEmail,
  subject: `Booking Confirmed #${bookingId} - Comar Garage`,
  html: buildEmailShell({
    title: 'Booking Confirmed',
    eyebrow: 'COMAR GARAGE',
    bodyHtml: `
      <p style="margin: 0 0 16px; font-size: 15px; color: #1f2937;">Hi <strong>${escapeHtml(customerName)}</strong>,</p>
      <p style="margin: 0 0 16px; font-size: 15px; color: #374151; line-height: 1.7;">Your appointment has been successfully scheduled. Here are your booking details:</p>
      <div style="background: #f5f5f4; border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; margin: 12px 0 18px;">
        <div style="display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; border-bottom: 1px solid #e5e7eb; padding-bottom: 10px; margin-bottom: 10px;">
          <span style="color: #6b7280; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;">Booking ID</span>
          <strong style="color: #111827;">#${escapeHtml(bookingId)}</strong>
        </div>
        <div style="display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; border-bottom: 1px solid #e5e7eb; padding-bottom: 10px; margin-bottom: 10px;">
          <span style="color: #6b7280; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;">Service</span>
          <strong style="color: #111827; text-align: right;">${escapeHtml(serviceName)}</strong>
        </div>
        <div style="display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; border-bottom: 1px solid #e5e7eb; padding-bottom: 10px; margin-bottom: 10px;">
          <span style="color: #6b7280; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;">Date &amp; Time</span>
          <strong style="color: #111827; text-align: right;">${escapeHtml(new Date(scheduledAt).toLocaleString())}</strong>
        </div>
        <div style="display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap;">
          <span style="color: #6b7280; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;">Total Amount</span>
          <strong style="color: #a91b18; text-align: right; font-size: 20px;">PHP ${escapeHtml(totalAmount)}</strong>
        </div>
      </div>
      <p style="margin: 0; font-size: 15px; color: #374151; line-height: 1.7;">You can check your booking status anytime through your customer dashboard.</p>
    `,
    ctaLink: `${appUrl('/customer/bookings')}`,
    ctaLabel: 'View Booking',
    footerNote: 'Comar Garage | 39 Hunters ROTC, Barangay San Juan, Cainta, 1900 Rizal'
  })
});

const sendPasswordResetEmail = async ({ customerEmail, resetLink }) => send({
  to: customerEmail,
  subject: 'Password Reset Request - Comar Garage',
  html: buildEmailShell({
    title: 'Reset Your Password',
    eyebrow: 'ACCOUNT SECURITY',
    bodyHtml: `
      <p style="margin: 0 0 16px; font-size: 15px; color: #1f2937;">Hi there,</p>
      <p style="margin: 0 0 16px; font-size: 15px; color: #374151; line-height: 1.7;">We received a request to reset your Comar Garage password. Click the button below to continue and create a new one securely.</p>
      <p style="margin: 0 0 8px; font-size: 14px; color: #6b7280; line-height: 1.6;">If you did not request this change, you can safely ignore this email and your password will remain unchanged.</p>
    `,
    ctaLink: resetLink,
    ctaLabel: 'Reset Password',
    footerNote: 'Secure access link expires in 1 hour. If you need help, contact the studio support team.'
  })
});

const sendAccountInviteEmail = async ({ customerEmail, customerName, inviteLink }) => send({
  to: customerEmail,
  subject: 'Create your Comar Garage customer account',
  html: buildEmailShell({
    title: 'Activate Your Account',
    eyebrow: 'WELCOME TO COMAR GARAGE',
    bodyHtml: `
      <p style="margin: 0 0 16px; font-size: 15px; color: #1f2937;">Hi <strong>${escapeHtml(customerName || 'Guest')}</strong>,</p>
      <p style="margin: 0 0 16px; font-size: 15px; color: #374151; line-height: 1.7;">Your account is almost ready. Use the secure link below to confirm your email and complete your profile.</p>
      <p style="margin: 0; font-size: 14px; color: #6b7280; line-height: 1.6;">This invitation expires in 48 hours. Once confirmed, you can view bookings, payments, and service updates in one place.</p>
    `,
    ctaLink: inviteLink,
    ctaLabel: 'Create Account',
    footerNote: 'This invitation is valid for 48 hours. If you believe this was sent in error, please contact support.'
  })
});

const sendAdminInviteEmail = async ({ recipientEmail, firstName, lastName, role, defaultPassword, loginLink }) => send({
  to: recipientEmail,
  subject: `[ACTION REQUIRED] Your Comar Garage ${role} account is ready`,
  html: buildEmailShell({
    title: 'Your Account Is Ready',
    eyebrow: 'COMAR GARAGE TEAM ACCESS',
    bodyHtml: `
      <p style="margin: 0 0 16px; font-size: 15px; color: #1f2937;">Hi <strong>${escapeHtml(`${firstName || ''} ${lastName || ''}`.trim() || 'there')}</strong>,</p>
      <p style="margin: 0 0 16px; font-size: 15px; color: #374151; line-height: 1.7;">An account has been created for you on the Comar Garage platform with the role <strong>${escapeHtml(role)}</strong>.</p>
      <p style="margin: 0 0 8px; font-size: 12px; color: #6b7280; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;">Email Address</p>
      <div style="background: #f5f5f4; border: 1px solid #e5e7eb; border-radius: 12px; padding: 14px 16px; margin-bottom: 16px; font-family: 'Courier New', Courier, monospace; font-size: 15px; color: #111827; font-weight: 700;">${escapeHtml(recipientEmail)}</div>
      <p style="margin: 0 0 8px; font-size: 12px; color: #6b7280; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;">Temporary Password</p>
      <div style="background: #f5f5f4; border: 1px solid #e5e7eb; border-radius: 12px; padding: 14px 16px; margin-bottom: 18px; font-family: 'Courier New', Courier, monospace; font-size: 20px; letter-spacing: 2px; color: #a91b18; font-weight: 900;">${escapeHtml(defaultPassword)}</div>
      <p style="margin: 0; font-size: 14px; color: #6b7280; line-height: 1.6;">For your security you will be required to set a new password the first time you sign in. Your temporary password cannot be used to access the platform beyond that first login.</p>
    `,
    ctaLink: loginLink,
    ctaLabel: 'Sign In & Set Password',
    footerNote: 'If you were not expecting this invitation, please contact the studio administrator immediately.'
  })
});

const sendInviteAccountEmail = async ({ recipientEmail, firstName, lastName, role, temporaryPassword, loginLink }) => send({
  to: recipientEmail,
  subject: `[ACTION REQUIRED] Your Comar Garage ${role} invitation`,
  html: buildEmailShell({
    title: 'You Have Been Invited',
    eyebrow: 'COMAR GARAGE TEAM ACCESS',
    bodyHtml: `
      <p style="margin: 0 0 16px; font-size: 15px; color: #1f2937;">Hi <strong>${escapeHtml(`${firstName || ''} ${lastName || ''}`.trim() || 'there')}</strong>,</p>
      <p style="margin: 0 0 16px; font-size: 15px; color: #374151; line-height: 1.7;">An administrator has created a <strong>${escapeHtml(role)}</strong> account for you on the Comar Garage platform. Use the temporary credentials below to sign in for the first time.</p>
      <p style="margin: 0 0 8px; font-size: 12px; color: #6b7280; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;">Email Address</p>
      <div style="background: #f5f5f4; border: 1px solid #e5e7eb; border-radius: 12px; padding: 14px 16px; margin-bottom: 16px; font-family: 'Courier New', Courier, monospace; font-size: 15px; color: #111827; font-weight: 700;">${escapeHtml(recipientEmail)}</div>
      <p style="margin: 0 0 8px; font-size: 12px; color: #6b7280; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;">Temporary Password</p>
      <div style="background: #f5f5f4; border: 1px solid #e5e7eb; border-radius: 12px; padding: 14px 16px; margin-bottom: 18px; font-family: 'Courier New', Courier, monospace; font-size: 20px; letter-spacing: 2px; color: #a91b18; font-weight: 900;">${escapeHtml(temporaryPassword)}</div>
      <p style="margin: 0; font-size: 14px; color: #6b7280; line-height: 1.6;">For your security, you will be required to set a new password on your first sign-in. Your temporary password cannot be used to access the platform beyond that first login.</p>
    `,
    ctaLink: loginLink,
    ctaLabel: 'Sign In & Set Password',
    footerNote: 'If you were not expecting this invitation, please contact the studio administrator immediately.'
  })
});

const sendEmergencyRecoveryEmail = async ({ recipientEmail, otp }) => send({
  to: recipientEmail,
  subject: 'Speedway Account Recovery Code',
  html: buildEmailShell({
    title: 'Account Recovery',
    eyebrow: 'ACCOUNT SECURITY',
    bodyHtml: `
      <p style="margin: 0 0 16px; font-size: 15px; color: #1f2937;">We received a request to unlock your Speedway account.</p>
      <p style="margin: 0 0 16px; font-size: 15px; color: #374151; line-height: 1.7;">Enter the recovery code below to unlock your account and reset your password:</p>
      <div style="font-size: 32px; font-weight: 900; letter-spacing: 8px; padding: 16px 20px; background: #f5f5f4; border: 1px solid #e5e7eb; border-radius: 12px; color: #111827; display: inline-block; margin-bottom: 16px;">${escapeHtml(otp)}</div>
      <p style="margin: 0; font-size: 13px; color: #6b7280; line-height: 1.6;">This code expires in 15 minutes and can only be used once. If you did not request this, you can safely ignore this email — your account remains locked and secure.</p>
    `,
    footerNote: 'Speedway Detail Studio | Account Security'
  })
});

// ── Task 3.3: QR Change security-verification email ────────────────────────
// Branded HTML shell wrapping a dark (#111827) banner, an explicit metadata
// block (timestamp / admin email / request IP), a prominent 28px monospace OTP
// container, and an explicit 5-minute expiry + security-warning footer.
const sendQrChangeOtpEmail = async ({ recipientEmail, otp, requestedAt, requestIp }) => {
  const timestamp = requestedAt ? new Date(requestedAt).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'long' }) : new Date().toLocaleString();
  const metaRow = (label, value) => `
    <tr>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7280; white-space: nowrap; vertical-align: top;">${escapeHtml(label)}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-size: 13px; font-weight: 700; color: #111827; word-break: break-word;">${escapeHtml(value)}</td>
    </tr>`;
  return send({
    to: recipientEmail,
    subject: 'Speedway: QR Change Verification Code',
    html: buildEmailShell({
      title: 'Verify Your Request',
      eyebrow: 'SPEEDWAY SECURITY',
      bodyHtml: `
        <div style="background: #111827; border-radius: 12px; padding: 16px 20px; margin-bottom: 18px; text-align: center;">
          <div style="font-size: 18px; font-weight: 900; letter-spacing: 4px; color: #f9fafb; text-transform: uppercase;">SPEEDWAY</div>
          <div style="font-size: 10px; letter-spacing: 2px; color: #9ca3af; margin-top: 6px; text-transform: uppercase;">AutoxMoto Detail Studio</div>
        </div>
        <p style="margin: 0 0 16px; font-size: 15px; color: #1f2937;">A request was made to change the <strong>Business Hub QR payment recipients</strong>.</p>
        <p style="margin: 0 0 8px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7280;">Request Details</p>
        <table style="width: 100%; border-collapse: collapse; border: 1px solid #e5e7eb; border-radius: 12px; overflow: hidden; margin-bottom: 18px;">
          <tbody>
            ${metaRow('Timestamp', timestamp)}
            ${metaRow('Admin Email', recipientEmail)}
            ${metaRow('Request IP Address', requestIp || 'Unavailable')}
          </tbody>
        </table>
        <p style="margin: 0 0 8px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7280; text-align: center;">Your Verification Code</p>
        <div style="text-align: center; margin-bottom: 16px;">
          <div style="display: inline-block; font-family: 'Courier New', Courier, monospace; font-size: 28px; font-weight: 900; letter-spacing: 10px; padding: 16px 24px; background: #f5f5f4; border: 1px solid #e5e7eb; border-radius: 12px; color: #111827;">${escapeHtml(otp)}</div>
        </div>
        <p style="margin: 0 0 16px; font-size: 14px; color: #374151; line-height: 1.7; text-align: center;">Enter this 6-digit code to authorize the change. <strong style="color: #a91b18;">This code expires in 5 minutes</strong> and can only be used once.</p>
        <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 12px; padding: 14px 16px;">
          <p style="margin: 0; font-size: 13px; color: #991b1b; line-height: 1.6; font-weight: 600;">Security warning: If you did not request this change, do not share this code with anyone. Review your account immediately and contact the studio administrator.</p>
        </div>
      `,
      footerNote: 'Speedway Detail Studio | Security Verification'
    })
  });
};

const sendStatusUpdateEmail = async ({ customerEmail, customerName, bookingId, status, scheduledAt }) => send({
  to: customerEmail,
  subject: `Booking Update #${bookingId} - Speedway AutoxMoto`,
  html: buildEmailShell({
    title: 'Booking Update',
    eyebrow: 'SERVICE STATUS',
    bodyHtml: `
      <p style="margin: 0 0 16px; font-size: 15px; color: #1f2937;">Hi <strong>${escapeHtml(customerName)}</strong>,</p>
      <p style="margin: 0 0 16px; font-size: 15px; color: #374151; line-height: 1.7;">Your booking <strong>#${escapeHtml(bookingId)}</strong> is now <strong>${escapeHtml(status)}</strong>.</p>
      <div style="background: #f5f5f4; border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; margin: 12px 0 18px;">
        <div style="display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap;">
          <span style="color: #6b7280; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;">Scheduled Time</span>
          <strong style="color: #111827; text-align: right;">${escapeHtml(new Date(scheduledAt).toLocaleString())}</strong>
        </div>
      </div>
      <p style="margin: 0; font-size: 15px; color: #374151; line-height: 1.7;">You can continue monitoring updates in your customer portal.</p>
    `,
    ctaLink: `${appUrl('/customer/bookings')}`,
    ctaLabel: 'Open Portal',
    footerNote: 'Speedway Detail Studio | 39 Hunters ROTC, Barangay San Juan, Cainta, 1900 Rizal'
  })
});

module.exports = {
  buildEmailShell,
  send,
  sendBookingConfirmationEmail,
  sendPasswordResetEmail,
  sendAccountInviteEmail,
  sendAdminInviteEmail,
  sendInviteAccountEmail,
  sendEmergencyRecoveryEmail,
  sendQrChangeOtpEmail,
  sendStatusUpdateEmail
};
