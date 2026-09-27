# Configuration Guide — why email links went to localhost, and how to fix it

This document answers the reported defects that were **configuration**, not code,
and gives the exact steps to set each value. Read the section for the symptom you
saw.

---

## 1. Email confirmation links open `localhost` instead of the app

### Symptom
Clicking the confirm button in a password-change / password-reset / signup email
opens `http://localhost:5173/...` (a page that cannot load for the recipient)
instead of the deployed site.

### Root cause
Every emailed link is built from **one** value on the backend:

```
FRONTEND_URL
```

`backend/services/appUrl.js` composes `appUrl('/password-confirmation?token=…')`
as `FRONTEND_URL + path`. In this repository the committed value is:

```
# backend/.env
FRONTEND_URL=http://localhost:5173
```

That is correct for local development, but if it is also present (or not
overridden) in the **production** environment, the server builds a link to the
*recipient's own machine*. The email sends successfully and looks fine — only the
link is unusable.

### The fix
Set `FRONTEND_URL` to the **public origin of the deployed frontend** in the
backend host's environment (Render), with **no trailing slash**:

```
FRONTEND_URL=https://your-deployed-frontend.example.com
```

> **This is now enforced.** The server refuses to boot in production when
> `FRONTEND_URL` is missing, is a `localhost`/loopback address, or is not
> `https://`. That turns a silent bad-link into a loud deploy failure
> (`backend/config/startupGuard.js`). You will see it in the Render deploy log.

Where to set it: **Render → your service → Environment → `FRONTEND_URL`**.
`render.yaml` already declares the key with `sync: false`, which tells Render to
prompt for the value rather than read it from the repository.

---

## 2. "Rotate Security Key" fails, invites fail, service deletion does nothing — and the console is silent

### Symptom
- Changing the password ("Rotate Security Key") reports *"Identity verification
  failed. Incorrect password."* even when the password is right.
- Inviting a staff/admin account fails with an opaque message.
- Deleting a service does nothing after the confirmation modal.
- Nothing obvious in the console.

### Root cause
All three actions call the backend at `VITE_BACKEND_URL`. In this repository:

```
# frontend/.env
VITE_BACKEND_URL=http://localhost:3000
```

Vite **inlines `VITE_*` at BUILD time**. A deployed build produced with this
value ships every visitor a bundle that calls *their own machine* on port 3000.
Nothing listens there, so each call dies with `net::ERR_CONNECTION_REFUSED` —
which is easy to miss, and which the password flow swallows into a generic
"verification failed".

### The fix
Set `VITE_BACKEND_URL` to the **public origin of the deployed backend** in the
frontend host's build environment, then **rebuild** (it is baked into the
bundle, so an env change alone does nothing until a new build):

**Vercel → your project → Settings → Environment Variables → `VITE_BACKEND_URL`**

```
VITE_BACKEND_URL=https://your-deployed-backend.example.com
```

> **This is now defended in code.** `frontend/src/config/api.js` is the single
> resolver every call site now imports. If `VITE_BACKEND_URL` is a localhost
> address but the page is *not* being served from localhost, the resolver:
>   1. logs a loud, explicit `console.error` naming the misconfiguration, and
>   2. falls back to `window.location.origin` instead of calling the visitor's
>      machine.
>
> It also honours a **runtime override** so a deploy can be corrected without a
> rebuild — see §3.

---

## 3. Correcting a live deploy without a rebuild (optional)

The resolver checks `window.__APP_CONFIG__.backendUrl` **first**. To point a
running site at the right backend without rebuilding, add this to
`frontend/index.html` `<head>` (or inject it from your host):

```html
<script>
  window.__APP_CONFIG__ = {
    backendUrl: 'https://your-deployed-backend.example.com'
  };
</script>
```

Precedence is: `window.__APP_CONFIG__.backendUrl` → `VITE_BACKEND_URL` →
`window.location.origin`.

---

## 4. Supabase Auth redirect allow-list (required for signup confirmation)

Even with `FRONTEND_URL` correct, Supabase will **ignore** the `emailRedirectTo`
the app sends unless the URL is allow-listed. If it is not, Supabase falls back
to the project's **Site URL** — which is itself often left as `localhost:3000`,
producing exactly the reported "confirmation link goes to localhost".

**Supabase Dashboard → Authentication → URL Configuration:**

| Setting | Value |
|---|---|
| **Site URL** | `https://your-deployed-frontend.example.com` |
| **Redirect URLs** | `https://your-deployed-frontend.example.com/auth/callback` |
| | `https://your-deployed-frontend.example.com/password-confirmation` |
| | `http://localhost:5173/auth/callback` *(keep for local dev)* |
| | `http://localhost:5173/password-confirmation` *(keep for local dev)* |

The two paths that matter:

- `/auth/callback` — consumes the signup/recovery session fragment and routes by
  role (`frontend/src/pages/AuthCallback.jsx`).
- `/password-confirmation` — the one-time password-change/reset link
  (`frontend/src/pages/PasswordConfirmation.jsx`).

---

## 5. Admin invites: "Only administrators may invite accounts" (fixed in code)

### Symptom
A logged-in **ADMIN** is refused when inviting a staff or admin account.

### Root cause
Not configuration — a defect. The invite route did its own correct admin check,
then called the `create_invited_account` RPC through the **service-role** client,
where `auth.uid()` is `NULL`. That RPC's *own* guard was `if not is_admin()`, and
`is_admin()` is `auth.uid()`-based, so it was **always false** for the backend
call. Every invite was rejected by the RPC's redundant guard regardless of who
clicked the button.

### The fix
Migration `20261019000001_fix_invite_service_role_guard.sql` adds
`public.is_privileged_caller()` — true for a real ADMIN via their own JWT **or**
for the trusted service-role backend (which has already verified the caller) —
and re-issues `create_invited_account` and `elevate_profile_role` to use it. A
plain signed-in user calling those RPCs directly is still refused.

**Action required:** apply the migration (see §6).

---

## 6. Apply the pending migrations

The new guard above only takes effect once the migration is applied:

```powershell
npx supabase db push
# or, to see what is outstanding first:
npx supabase migration list
```

Verify the guard is live:

```sql
select public.is_privileged_caller();          -- true as service_role / admin
select public.create_invited_account(
  'someone@example.com', 'First', 'Last', 'STAFF', true);
```

---

## Quick checklist

| Where | Variable | Value |
|---|---|---|
| Render (backend) | `FRONTEND_URL` | `https://<frontend-domain>` (https, no trailing slash) |
| Vercel (frontend build) | `VITE_BACKEND_URL` | `https://<backend-domain>` |
| Supabase Auth | Site URL + Redirect URLs | the `/auth/callback` and `/password-confirmation` URLs |
| Supabase DB | — | `npx supabase db push` |

After changing a `VITE_*` variable you must **redeploy the frontend**; after
changing a backend variable, **redeploy the backend**. A `FRONTEND_URL` that is
still localhost will now stop the backend from booting, by design.