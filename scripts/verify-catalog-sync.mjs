// Keeps the browser's pricing and the database's price check in agreement.
//   node scripts/verify-catalog-sync.mjs                    static check only (no database)
//   node scripts/verify-catalog-sync.mjs --db <container>   also compares them against a scratch database
//
// Static: the built-in catalog stored by the migration is exactly what servicesCatalog.js defines.
// Database: (1) the database's price for every built-in service/vehicle equals the browser's;
//           (2) PROPERTY TEST: for hundreds of generated bookings and several promotion setups, the
//               total the browser computes (priceVehicleServices) is ACCEPTED by assert_booking_pricing.
//               A legitimate booking must never be refused by the server-side check.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { SERVICES_DATA, setCatalogSource, getServiceCatalog, priceVehicleServices } from '../frontend/src/data/servicesCatalog.js';
import { catalogInsertSql, catalogRows, catalogDurationSql } from './gen-catalog-seed.mjs';

const MIGRATION = 'supabase/migrations/20261121000001_new_service_catalog.sql';
const sql = fs.readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n');
assert.ok(sql.includes(catalogInsertSql()), 'the migration\'s built-in catalog differs from frontend/src/data/servicesCatalog.js. Regenerate it with scripts/gen-catalog-seed.mjs');
console.log(`static OK: migration catalog matches servicesCatalog.js (${catalogRows().length} service/vehicle prices)`);

const durationSql = fs.readFileSync('supabase/migrations/20261121000001_new_service_catalog.sql', 'utf8').replace(/\r\n/g, '\n');
assert.ok(durationSql.includes(catalogDurationSql()), 'the add-service migration service durations differ from servicesCatalog.js. Regenerate them with scripts/gen-catalog-seed.mjs');
console.log('static OK: migration service durations match servicesCatalog.js');

// ── Vehicle-category aliases: the SQL copy must agree with the one JS rule ──
// catalog_vehicle_key (SQL) is the database's copy of canonicalVehicleKey
// (frontend/src/config/vehicleTypes.js). Parse the SQL `when ... then 'Key'`
// lines, evaluate them the way Postgres would, and compare over every alias the
// SQL lists plus the built-in keys and case/separator variants.
{
  const { canonicalVehicleKey } = await import('../frontend/src/config/vehicleTypes.js');
  const { VEHICLE_TYPE_KEYS } = await import('../frontend/src/config/constants.js');
  const fn = sql.slice(sql.indexOf('function public.catalog_vehicle_key'));
  const body = fn.slice(fn.indexOf('return case'), fn.indexOf('else v_raw'));
  const rules = [...body.matchAll(/when\s+(.+?)\s+then\s+'([^']+)'/g)].map((m) => ({
    key: m[2],
    tests: [...m[1].matchAll(/(v_norm|v_flat)\s+(?:in\s*\(([^)]*)\)|=\s*'([^']*)')/g)].map((t) => ({
      col: t[1],
      vals: t[2] ? [...t[2].matchAll(/'([^']*)'/g)].map((v) => v[1]) : [t[3]]
    }))
  }));
  assert.ok(rules.length >= 9, 'could not parse catalog_vehicle_key; update this check if its shape changed');
  const sqlKey = (value) => {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    const norm = raw.toLowerCase().replace(/[_/-]+/g, ' ').replace(/\s+/g, ' ').trim();
    const flat = norm.replace(/ /g, '');
    const hit = rules.find((r) => r.tests.some((t) => t.vals.includes(t.col === 'v_norm' ? norm : flat)));
    return hit ? hit.key : raw;
  };
  const corpus = new Set(VEHICLE_TYPE_KEYS);
  rules.forEach((r) => r.tests.forEach((t) => t.vals.forEach((v) => corpus.add(v))));
  [...corpus].forEach((v) => { corpus.add(v.toUpperCase()); corpus.add(v.replace(/ /g, '_')); corpus.add(v.replace(/ /g, '-')); corpus.add(`  ${v} `); });
  corpus.add('Trike'); corpus.add('Jeep Wrangler');
  for (const value of corpus) {
    assert.equal(canonicalVehicleKey(value), sqlKey(value),
      `vehicle alias drift for "${value}": JS canonicalVehicleKey gives "${canonicalVehicleKey(value)}", SQL catalog_vehicle_key gives "${sqlKey(value)}". Keep config/vehicleTypes.js and the SQL function in step.`);
  }
  console.log(`static OK: JS canonicalVehicleKey agrees with SQL catalog_vehicle_key (${corpus.size} samples)`);
}

const dbIndex = process.argv.indexOf('--db');
if (dbIndex < 0) process.exit(0);
const container = process.argv[dbIndex + 1];

const psql = (input) => {
  const result = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=0', '-tA', '-F', '|'], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return `${result.stdout || ''}${result.stderr || ''}`;
};

// ── (1) price parity for every built-in ─────────────────────────────────────
const rows = catalogRows();
const parity = psql(`
begin;
set local session_replication_role = replica;
update business_config set custom_services = '[]', archived_service_ids = '[]', deleted_service_ids = '[]';
select name || '|' || vehicle_key || '|' || coalesce(public.catalog_service_price(name, vehicle_key)::text, 'NULL') from public.catalog_builtin_services;
rollback;`);
const dbPrices = new Map(parity.split('\n').filter((l) => l.split('|').length === 3).map((l) => { const [n, v, p] = l.split('|'); return [`${n}|${v}`, p]; }));
setCatalogSource({ customServices: [], archivedServiceIds: [], deletedServiceIds: [], promoRules: [], vehicleTypes: [] });
let mismatches = 0;
for (const r of rows) {
  const browser = Object.values(getServiceCatalog()).flat().find((s) => s.name === r.name)?.prices?.[r.vehicle];
  if (Number(dbPrices.get(`${r.name}|${r.vehicle}`)) !== Number(browser)) { mismatches += 1; console.error('price mismatch', r.name, r.vehicle, dbPrices.get(`${r.name}|${r.vehicle}`), browser); }
}
assert.equal(mismatches, 0, 'database and browser catalog prices differ');
console.log(`parity OK: ${rows.length} built-in prices identical in the browser and the database`);

// ── (2) property test ───────────────────────────────────────────────────────
const VEHICLES = ['Hatch', 'Sedan', 'AUV', 'SUV', 'Pickup', 'Van Small', 'Van Medium', 'Van Large', 'Regular', 'Bigbike'];
const pkg = { id: 'pk', mode: 'package', type: 'fixed_package', value: 500, name: 'Bundle', active: true, vehicleTypes: ['Sedan'], serviceMatches: ['Basic Carwash', 'Premium All Carwash'] };
const SETUPS = {
  none: [],
  ten_percent: [{ id: 'a', type: 'percentage', value: 10, name: '10', active: true }],
  fixed_100: [{ id: 'b', type: 'fixed', value: 100, name: '100', active: true }],
  stacked: [{ id: 'c', type: 'percentage', value: 10, name: '10', active: true }, { id: 'd', type: 'fixed', value: 50, name: '50', active: true }],
  scoped_percent: [{ id: 'e', type: 'percentage', value: 25, name: 'wash', active: true, vehicleTypes: ['Sedan', 'SUV'], serviceMatches: ['Carwash'] }],
  package: [pkg],
  package_and_percent: [pkg, { id: 'f', type: 'percentage', value: 20, name: '20', active: true }],
  matrix: [{ id: 'g', type: 'percentage', value: 15, name: 'matrix', active: true, vehicleServiceMatrix: { Sedan: ['Basic Carwash', 'Asphalt, Bug and Tar Removal'] } }]
};
let seed = 42;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (list, n) => { const copy = [...list]; const out = []; while (out.length < n && copy.length) out.push(copy.splice(Math.floor(rnd() * copy.length), 1)[0]); return out; };

const priced = (vehicle) => rows.filter((r) => r.vehicle === vehicle);
let script = 'begin;\nset local session_replication_role = replica;\nupdate business_config set custom_services = \'[]\', archived_service_ids = \'[]\', deleted_service_ids = \'[]\';\nset local session_replication_role = origin;\n';
script += `select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);\n`;
script += `create or replace function pg_temp.check_case(p_label text, p_payload jsonb) returns text language plpgsql as $$ begin perform public.assert_booking_pricing(p_payload); return 'OK|' || p_label; exception when others then return 'REFUSED|' || p_label || '|' || sqlerrm; end $$;\n`;
let cases = 0;
for (const [label, rules] of Object.entries(SETUPS)) {
  setCatalogSource({ customServices: [], archivedServiceIds: [], deletedServiceIds: [], promoRules: rules, vehicleTypes: [] });
  script += `set local session_replication_role = replica; update business_config set promo_rules = '${JSON.stringify(rules).replace(/'/g, "''")}'::jsonb; set local session_replication_role = origin;\n`;
  script += `set local role authenticated;\n`;
  for (let i = 0; i < 40; i += 1) {
    const vehicles = pick(VEHICLES, 1 + Math.floor(rnd() * 3)).map((type) => {
      const offered = priced(type);
      const chosen = pick(offered, 1 + Math.floor(rnd() * Math.min(4, offered.length)));
      // package scenarios must sometimes hold the whole bundle
      if (label.startsWith('package') && type === 'Sedan' && rnd() < 0.6) {
        for (const name of ['Basic Carwash', 'Premium All Carwash']) if (!chosen.some((c) => c.name === name)) chosen.push(offered.find((o) => o.name === name));
      }
      return { type, services: chosen.filter(Boolean).map((c) => ({ name: c.name, price: c.price })) };
    });
    const total = vehicles.reduce((sum, v) => sum + priceVehicleServices(v.type, v.services).unitSubtotal, 0);
    const payload = {
      booking: { total_amount: Math.round(total * 100) / 100 },
      vehicles: vehicles.map((v) => ({ vehicle: { vehicle_type: v.type }, services: v.services.map((s) => ({ service_name: s.name })) }))
    };
    script += `select pg_temp.check_case(${JSON.stringify(`${label} #${i}`).replace(/"/g, "'")}, '${JSON.stringify(payload).replace(/'/g, "''")}'::jsonb);\n`;
    cases += 1;
  }
  script += 'reset role;\n';
}
script += 'rollback;\n';

const output = psql(script).split('\n');
const ok = output.filter((l) => l.startsWith('OK|')).length;
const refused = output.filter((l) => l.startsWith('REFUSED|'));
if (refused.length || ok !== cases) {
  console.error(`property test FAILED: ${ok}/${cases} accepted`);
  refused.slice(0, 8).forEach((l) => console.error('  ' + l));
  process.exit(1);
}
console.log(`property test OK: all ${cases} browser-priced bookings across ${Object.keys(SETUPS).length} promotion setups were accepted by the database check`);
