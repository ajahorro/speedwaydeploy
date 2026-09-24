# Email Authentication Policy — OTP vs. LINK

**Status:** AUTHORITATIVE. Any flow that emails a user for authentication MUST
follow this document. If a new flow does not fit a rule here, add a rule —
do not improvise.

---

## Why this exists

A user clicked **"Send Recovery Link"** on Forgot Password and received an
**OTP** instead. Root cause: the flow called `supabase.auth.resetPasswordForEmail()`,
which uses **Supabase's own Auth email template** (default body renders the
6-digit `{{ .Token }}`) and **bypasses our branded Resend relay**. The UI promised
a link; the mailbox delivered a code no screen accepted.

The fix is as much about *enforcement* as about the one bug: two parallel email
systems (Supabase Auth templates + our Resend relay) existed with no rule saying
which is which. This policy removes the ambiguity.

---

## The two delivery mechanisms

| | **LINK** | **OTP** |
|---|---|---|
| What arrives | A one-time URL with a high-entropy token | A 6-digit numeric code |
| Sender path | **Our backend → Resend relay** (`sendPasswordConfirmationEmail` / `buildEmailShell`) | Supabase Auth template (`{{ .Token }}`) OR backend-generated code |
| Verified by | Opening the URL → `/password-confirmation?token=...` → `confirm-password-change` | Typing the code into an in-app modal |
| Token storage | `password_confirmation_requests.token_hash` (hashed, single-use, 15-min TTL) | short-lived row/column, single-use |
| Strength | 256-bit random (`crypto.randomBytes(32)`) | 10^6 space, rate-limited |

---

## THE RULE (decision table)

Use **LINK** when the user is NOT yet proven to control the inbox and needs to
complete an action on another device/session, OR when the action is a
high-value, one-time, multi-step change:

| Flow | Mechanism | Endpoint / path |
|---|---|---|
| Forgot password (unauthenticated) | **LINK** | `/api/auth/recover-password` → `/password-confirmation?token=` |
| Change password (authenticated, current pw required) | **LINK** | `/api/auth/request-password-change` |
| Resend password confirmation | **LINK** | `/api/auth/resend-password-confirmation` |
| Change email — confirm on OLD address | **LINK** | `/api/auth/request-email-change` |
| Payment recipient / QR change (admin) | **OTP** | `/api/admin/...` OTP modal |

Use **OTP** when the user IS already authenticated OR is mid-session and a
second, low-friction proof-of-possession is needed on the *same* screen:

| Flow | Mechanism | Rationale |
|---|---|---|
| Emergency account recovery (DB-locked) | **OTP** | user is already interacting with a recovery modal; code is quicker than leaving the app |
| QR / payee change step-up | **OTP** | in-app modal, same-session confirmation |
| Any destructive single-step confirm | OTP | fast second factor |

### Invariants (hard rules — violating any is a bug)

1. **UI copy must match the mechanism.** If the button says "link", a LINK is
   sent. If it says "code"/"OTP", an OTP is sent. Never cross them.
2. **Never call `supabase.auth.resetPasswordForEmail` / `signInWithOtp` /
   `inviteUserByEmail` directly from the app.** Those use Supabase's templates
   and bypass the branded relay (and the rule above). Route through the backend.
3. **All outbound auth email goes through the Resend relay** (`buildEmailShell`)
   so branding, deliverability, and `emailDelivered` reporting stay uniform.
4. **LINK tokens are stored hashed and single-use** (`password_confirmation_requests`).
   Never email a raw token that is also persisted in plaintext.
5. **Supabase Auth email templates must render `{{ .ConfirmationURL }}`, never
   `{{ .Token }}`.** This is a defense-in-depth rule so that even if rule #2 is
   ever violated, the fallback email is still a link. (See checklist below.)
6. **OTPs are 6 numeric digits, single-use, TTL ≤ 15 min, rate-limited.**

---

## Where the code lives

- **Mechanism constants:** `backend/config/emailPolicy.js` (`DELIVERY.LINK` / `DELIVERY.OTP`, plus per-flow mapping).
- **LINK emails:** `sendPasswordConfirmationEmail()` in `backend/server.js`.
- **OTP generation:** `request-email-change` / emergency-recovery routes.
- **Frontend:** `useAuthFlow.recoverPassword` (LINK), `EmergencyRecoveryForm` (OTP).

## Supabase dashboard checklist (manual, one-time)

Supabase Studio → **Authentication → Email Templates**:

- **Reset Password**: change the body to use `{{ .ConfirmationURL }}` (a link).
  Remove `{{ .Token }}`.
- **Magic Link / OTP**: leave as-is **only** if you intend to send OTPs there.
  If unused, disable it.
- **Confirm signup / Change Email Address**: same — links, not tokens.

Until this is done, rule #2 keeps the app off those templates entirely.
