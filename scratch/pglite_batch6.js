// Batch 6 / Step 6.1 — execute the schedule-rules migration against a real
// Postgres (PGlite/WASM).
//
// Bare Postgres lacks the Supabase objects the migration references. We create
// minimal shims for exactly the surface the SQL touches, then run the migration
// verbatim. This is a genuine parse + semantics check: any syntax error, bad
// column reference, or invalid constraint predicate throws here.
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const dir = path.resolve(__dirname, '../supabase/migrations');
const file = '20260925000001_add_schedule_rules.sql';

// Minimal shim: business_config as it exists right before this migration.
const SHIMS = `
create table if not exists public.business_config (
  id int primary key default 1,
  opening_hour text default '07:00 AM',
  closing_hour text default '09:00 PM',
  slots_per_hour integer default 2,
  max_vehicles_per_staff integer default 4,
  updated_at timestamptz default now()
);
-- A pre-existing row, to prove defaults land on live data.
insert into public.business_config (id) values (1) on conflict do nothing;
`;

(async () => {
  const db = new PGlite();
  try {
    await db.exec(SHIMS);
    console.log('-- shims applied --');

    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    try {
      await db.exec(sql);
      console.log(`PASS  ${file} (parsed + executed)`);
    } catch (e) {
      console.log(`FAIL  ${file}\n        ${e.message}`);
      process.exitCode = 1;
      return;
    }

    const asserts = [];
    const q = async (s) => (await db.query(s)).rows;

    // 1. Columns exist with expected types / nullability / defaults.
    const cols = await q(`
      select column_name, data_type, is_nullable, column_default
      from information_schema.columns
      where table_schema='public' and table_name='business_config'
        and column_name in ('booking_lead_time_minutes','max_advance_days','closed_weekdays','enforce_capacity')
      order by column_name`);
    asserts.push(['all 4 schedule columns exist', cols.length === 4]);
    asserts.push(['booking_lead_time_minutes default 120',
      cols.some(c => c.column_name === 'booking_lead_time_minutes' && c.column_default && c.column_default.includes('120'))]);
    asserts.push(['max_advance_days default 30',
      cols.some(c => c.column_name === 'max_advance_days' && c.column_default && c.column_default.includes('30'))]);
    asserts.push(['closed_weekdays is integer[]',
      cols.some(c => c.column_name === 'closed_weekdays' && c.data_type === 'ARRAY')]);
    asserts.push(['enforce_capacity default true',
      cols.some(c => c.column_name === 'enforce_capacity' && c.column_default && c.column_default.includes('true'))]);

    // 2. Defaults applied to the pre-existing row.
    const row = (await q(`select booking_lead_time_minutes a, max_advance_days b, closed_weekdays c, enforce_capacity d from public.business_config where id=1`))[0];
    asserts.push(['existing row backfilled with defaults 120/30/[]/true',
      row.a === 120 && row.b === 30 && Array.isArray(row.c) && row.c.length === 0 && row.d === true]);

    // 3. Constraints registered.
    const cons = (await q(`select conname from pg_constraint where conrelid='public.business_config'::regclass`))
      .map(r => r.conname);
    asserts.push(['lead-time bounds constraint exists', cons.includes('business_config_lead_time_bounds')]);
    asserts.push(['advance-days bounds constraint exists', cons.includes('business_config_advance_days_bounds')]);
    asserts.push(['closed-weekdays validity constraint exists', cons.includes('business_config_closed_weekdays_valid')]);

    // 4. Constraints actually reject nonsense.
    const expectFail = async (label, stmt) => {
      try { await db.exec(stmt); asserts.push([label, false]); }
      catch { asserts.push([label, true]); }
    };
    await expectFail('rejects lead time > 43200',
      `update public.business_config set booking_lead_time_minutes = 99999 where id=1`);
    await expectFail('rejects max_advance_days = 0',
      `update public.business_config set max_advance_days = 0 where id=1`);
    await expectFail('rejects invalid weekday 9',
      `update public.business_config set closed_weekdays = array[9] where id=1`);

    // 5. Valid values are accepted.
    try {
      await db.exec(`update public.business_config set
        booking_lead_time_minutes = 60, max_advance_days = 14,
        closed_weekdays = array[0,6], enforce_capacity = false where id=1`);
      asserts.push(['accepts valid values (60 / 14 / {0,6} / false)', true]);
    } catch (e) { asserts.push(['accepts valid values (60 / 14 / {0,6} / false)', false]); }

    // 6. Idempotency: re-run the whole migration; nothing should throw or duplicate.
    try {
      await db.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
      const stillOne = (await q(`select count(*)::int n from public.business_config`))[0].n;
      asserts.push(['migration re-run is idempotent (still 1 config row)', stillOne === 1]);
    } catch (e) {
      asserts.push([`migration re-run is idempotent (${e.message})`, false]);
    }

    console.log('\n-- assertions --');
    let pass = 0, fail = 0;
    for (const [label, cond] of asserts) {
      if (cond) { pass++; console.log(`PASS  ${label}`); }
      else { fail++; console.log(`FAIL  ${label}`); }
    }
    console.log(`\n=== ${pass} passed, ${fail} failed ===`);
    if (fail > 0) process.exitCode = 1;
  } catch (e) {
    console.error('HARNESS ERROR:', e.message);
    process.exitCode = 1;
  }
})();
