# Staging environment (for alpha testing)

Alpha testers must not write to the live shop. Staging is a full copy of the stack that talks only to its own database:

| Piece | Production | Staging |
|---|---|---|
| Database, auth, storage, edge functions | Supabase project `nsmytxlaidmndtqxctrw` | a second Supabase project, `comar-garage-staging` |
| Backend | Render `speedway-backend` (branch `main`) | Render `comar-backend-staging` (branch `staging`, `render.staging.yaml`) |
| Website | Vercel production (`comargarage.com`, branch `main`) | Vercel deployment of the `staging` branch (its own URL) |
| Accounts | real | `alpha-*` test accounts (plus-addressed on one mailbox) |

Everything below is repeatable. Nothing here touches production.

## 0. One blocker you must clear first: a free Supabase slot

Supabase's free plan allows **2 active projects per account** and refused to create a second one for this account. Pick one:

1. **Pause or delete an old project** you no longer need (Supabase dashboard > the project > Settings > General > Pause or Delete). If an older staging/test project exists, *restoring* it (Settings > "Restore project") is the "renew" option, and then pass its ref with `--ref` below.
2. **Upgrade the organisation to Pro** (paid, roughly US$25 per month plus extra per additional project). Only choose this if you want it.

## 1. Supabase staging project (one command)

```bash
node scripts/staging/create-staging.mjs --email-base you@gmail.com            # creates the project
node scripts/staging/create-staging.mjs --email-base you@gmail.com --ref <ref> # or reuse one you made/restored
node scripts/staging/create-staging.mjs --dry-run --email-base you@gmail.com   # show the steps only
```

It creates the project (database password saved to `.staging-secrets/db-password.txt`, gitignored), waits until it is healthy, applies **every migration**, deploys the four edge functions, seeds the shop configuration and five accounts, writes `.staging-secrets/env.txt` with the values for Vercel and Render, and **restores the CLI link to production** even if a step fails.

Accounts (`+` addressing on your mailbox, so every email lands in one inbox): `alpha-admin`, `alpha-staff1`, `alpha-staff2`, `alpha-customer1`, `alpha-customer2`. Their random passwords are in `.staging-secrets/accounts.txt` (never printed, never committed). Send them to testers privately.

Then in the staging project's dashboard:
- **Authentication > URL configuration:** Site URL = the staging website address; add the same address to Redirect URLs.
- **Edge Functions > Secrets:** set `RESEND_API_KEY`, `RESEND_FROM` (and `SITE_URL` if used) so staging can send mail. Emails from staging are real emails.
- **Authentication > Password security:** turn on leaked-password protection, like production.
- **Storage:** the buckets (`service-proofs`, `payment-receipts`, `chat_media`, `receipts`) come from the migrations; check they exist.

## 2. Git branch

```bash
git checkout -b staging && git push -u origin staging
```
Merge `main` into `staging` whenever testers should get the latest build. (Keeping `staging` behind `main` lets you ship fixes to production first, then to testers.)

## 3. Render: the staging backend

Render dashboard > New + > **Blueprint** > this repository > Blueprint file path `render.staging.yaml`. Fill the prompted values from `.staging-secrets/env.txt` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) plus `FRONTEND_URL` (the staging website address) and your email values. Use the **starter** plan so it does not sleep. Note the service URL.

## 4. Vercel: the staging website

Vercel > Add New Project > this repository > Root Directory `frontend` > Production Branch `staging` (a second Vercel project, so production is unaffected). Environment variables from `.staging-secrets/env.txt`: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_BACKEND_URL` (the staging Render URL). Deploy; that address is the staging website.

## 5. Check it, then hand it to testers

```bash
curl https://<staging-render-url>/api/health         # status ok, supabaseReady true
```
Sign in as each alpha account on the staging website. Tell testers (alpha guide, section 2) the staging URL and that data there is disposable. To reset staging at any time: delete the bookings (the same SQL as `scripts/sql/reset-bookings-clean-slate.sql`, run in the **staging** SQL editor only) and re-run the seed.

## Safety rails already in the scripts
- `seed-staging.mjs` and `create-staging.mjs` **refuse** the production project reference.
- Database passwords and keys are written only to `.staging-secrets/` (gitignored).
- Existing account passwords are never overwritten or lost: later runs only add new lines.
