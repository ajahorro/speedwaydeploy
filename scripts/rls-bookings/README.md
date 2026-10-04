# bookings RLS test matrix (local only)

Checks the `public.bookings` policies from
`supabase/migrations/20261024000001_lock_down_bookings_rls.sql` for anon,
customer, staff, admin, deactivated admin and service role. **Run it only against
a throwaway local stack, never production** — `01_seed.sql` inserts users and
bookings.

```bash
# 1. Scratch stack on spare ports (54321-54327 are taken by the main local stack)
mkdir /tmp/rlstest && cd /tmp/rlstest && supabase init
#    edit supabase/config.toml: project_id, and 543xx -> 566xx ports
supabase start

# 2. Production schema (schema only, read-only dump) + fixtures
supabase db dump --linked -s public -f public_schema.sql   # run from the repo root
DB=supabase_db_<project_id>
docker exec -i $DB psql -U postgres -d postgres < public_schema.sql
docker exec -i $DB psql -U postgres -d postgres < scripts/rls-bookings/01_seed.sql
docker exec -i $DB psql -U postgres -d postgres < scripts/rls-bookings/02_harness.sql

# 3. Apply the migration and run the matrix (every line should be PASS)
docker exec -i $DB psql -U postgres -d postgres < supabase/migrations/20261024000001_lock_down_bookings_rls.sql
docker exec -i $DB psql -U postgres -d postgres -q < scripts/rls-bookings/03_matrix.sql | grep -E '^(PASS|FAIL)'

# 4. Same checks through PostgREST with the frontend's real select strings
docker exec $DB psql -U postgres -c "notify pgrst, 'reload schema'"
node scripts/rls-bookings/04_postgrest.cjs   # expects the stack on 127.0.0.1:56621
```

Running `03_matrix.sql` before step 3 shows the pre-migration exposure (anon can
SELECT/UPDATE/DELETE/INSERT every booking).
