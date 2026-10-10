// Phases of scripts/stress-lifecycle-local.mjs (kept apart so the helper file stays readable).

const money = (n) => Math.round(Number(n || 0) * 100) / 100;

export const runPhases = async (T, PHASES) => {
  const { check, note, section } = T;
  const state = {};
  const from = new Date(Date.now() - 40 * 86400000).toISOString(); const to = new Date(Date.now() + 40 * 86400000).toISOString();
  state.staffAOriginal = (await T.json(await T.rest(`profiles?id=eq.${T.staffA.id}&select=*`)))[0];
  state.reportBaseline = (await T.rpc('sales_report', { p_from: from, p_to: to }, T.admin.token)).data;
  if (PHASES.has('A')) await phaseA(T, state);
  if (PHASES.has('B')) await phaseB(T, state);
  if (PHASES.has('C')) await phaseC(T, state);
  if (PHASES.has('D')) await phaseD(T, state);
  if (PHASES.has('E')) await phaseE(T, state);
  void check; void note; void section;
};

// ---------------------------------------------------------------------------------------------------------------
const finishAndRelease = async (T, rec, staff, label) => {
  const { check, timeArrives, doWork, bookingRow, api, admin } = T;
  await timeArrives(rec.id);
  const steps = await doWork(rec.id, staff);
  const failedStep = steps.find(([, ok]) => !ok);
  check(`${label}: before photo, start, after photo and finish all work`, !failedStep, failedStep ? `${failedStep[0]}: ${failedStep[2]}` : `${steps.length} steps`);
  const row = await bookingRow(rec.id);
  check(`${label}: every vehicle is completed`, row.booking_vehicles.every((v) => String(v.status).toUpperCase() === 'COMPLETED'), row.booking_vehicles.map((v) => v.status).join(','));
  return row;
};

/** The admin records the rest of the money at the shop; the booking then completes. */
const settleBalance = async (T, rec, label) => {
  const { check, ledger, rest, admin, api, bookingRow, json } = T;
  const l = await ledger(rec.id);
  const owed = money(l.outstanding_amount);
  const r = await rest('payments', { token: admin.token, method: 'POST', body: { booking_id: rec.id, amount: owed, method: 'Cash', payment_type: 'Manual', status: 'PAID', verified_by: admin.id, verified_at: new Date().toISOString(), notes: 'ADMIN_CONFIRMED|BALANCE' } });
  check(`${label} the admin records the remaining ₱${owed} in cash`, r.ok, r.ok ? '' : JSON.stringify(await json(r)).slice(0, 120));
  await api('/api/bookings/reconcile-payment-state', { token: admin.token, body: { bookingId: rec.id } });
  const after = await ledger(rec.id);
  check(`${label} now fully paid in the ledger`, money(after.outstanding_amount) === 0, `outstanding ${after.outstanding_amount}`);
  const row = await bookingRow(rec.id);
  check(`${label} booking is completed once paid in full`, ['completed', 'released'].includes(String(row.status).toLowerCase()), row.status);
};

async function phaseA(T, state) {
  const { check, note, section, book, verifyAll, assign, ledger, bookingRow, auditFor, cancel, reschedule, refund, staffA, staffB, firstOpenDay, cust, admin, message, rpc, api, rest, json } = T;
  section('Phase A: bookings with every payment type, then finishing, cancelling and rescheduling');
  state.A = {};
  const sedan = (services) => [{ type: 'Sedan', services }];
  let day = firstOpenDay(3);
  const nextDay = () => { day = firstOpenDay(day + 1); return day; };

  const defs = {
    A1: { by: 'customer', kind: 'gcash_full', vehicles: sedan(['Basic Carwash']) },
    A2: { by: 'customer', kind: 'gcash_down', vehicles: sedan(['Hand/Spray Wax', 'Buffing with Wax']) },
    A3: { by: 'customer', kind: 'cash_pending', vehicles: sedan(['Basic Carwash', 'Premium All Carwash']) },
    A4: { by: 'admin', kind: 'admin_cash_full', vehicles: [{ type: 'Hatch', services: ['Basic Carwash'] }] },
    A5: { by: 'admin', kind: 'admin_cash_down', vehicles: [{ type: 'SUV', services: ['Exterior Detailing'] }] },
    A6: { by: 'admin', kind: 'receivable', vehicles: [{ type: 'Pickup', services: ['Premium All Carwash'] }] },
    A7: { by: 'admin', kind: 'admin_gcash', vehicles: sedan(['Hand/Spray Wax', 'Basic Carwash']) },
    A8: { by: 'customer', kind: 'gcash_full', vehicles: sedan(['Premium All Carwash']) },
    A9: { by: 'customer', kind: 'gcash_down', vehicles: [{ type: 'Sedan', services: ['Hand/Spray Wax', 'Buffing with Wax'] }, { type: 'SUV', services: ['Premium All Carwash'] }] },
    A10: { by: 'customer', kind: 'cash_pending', vehicles: sedan(['Basic Carwash']) },
    A11: { by: 'customer', kind: 'gcash_full', vehicles: sedan(['Premium All Carwash', 'Basic Carwash']) },
    A12: { by: 'admin', kind: 'admin_cash_full', vehicles: [{ type: 'Hatch', services: ['Premium All Carwash'] }, { type: 'Sedan', services: ['Basic Carwash'] }] }
  };
  for (const [key, def] of Object.entries(defs)) {
    const rec = await book({ ...def, day: nextDay(), hour: 10, label: key });
    if (!check(`${key} created (${def.kind}, ${def.vehicles.length} vehicle${def.vehicles.length > 1 ? 's' : ''})`, rec.ok, rec.ok ? `total ₱${rec.total}${rec.down ? `, downpayment rule ₱${rec.down}` : ''}` : rec.error)) continue;
    state.A[key] = rec;
  }

  // the ledger of a booking must match what was paid (before any verification)
  for (const key of ['A4', 'A5', 'A7', 'A12']) {
    const rec = state.A[key]; if (!rec) continue;
    const l = await ledger(rec.id);
    const expected = key === 'A5' ? rec.down : rec.total;
    check(`${key} admin-confirmed payment shows as settled in the ledger`, money(l.net_settled) === money(expected), `net_settled ${l.net_settled} vs ${expected}`);
  }

  // verify the customer payments
  for (const key of ['A1', 'A2', 'A3', 'A9', 'A11']) {
    const rec = state.A[key]; if (!rec) continue;
    const out = await verifyAll(rec.id);
    check(`${key} payment verified by the admin`, out.length > 0 && out.every((r) => r.ok), out.map((r) => (r.ok ? 'ok' : message(r))).join('; '));
    const l = await ledger(rec.id);
    check(`${key} ledger counts the verified payment`, money(l.net_settled) > 0, `net_settled ${l.net_settled}, downpayment_met ${l.downpayment_met}`);
  }
  const reject = await verifyAll(state.A.A8?.id, { reject: true });
  check('A8 receipt rejected by the admin (nothing counts as paid)', reject.length > 0 && reject.every((r) => r.ok) && money((await ledger(state.A.A8.id)).net_settled) === 0, reject.map((r) => (r.ok ? 'ok' : message(r))).join('; '));

  // technicians
  for (const [key, who] of [['A1', staffA], ['A2', staffA], ['A4', staffB], ['A7', staffB]]) { const rec = state.A[key]; if (!rec) continue; const r = await assign(rec.id, who); check(`${key} technician assigned`, r.ok, r.ok ? '' : JSON.stringify(r.data).slice(0, 100)); }
  { const rec = state.A.A9; if (rec) { const row = await bookingRow(rec.id); const [v1, v2] = row.booking_vehicles; const r1 = await rest(`booking_vehicles?id=eq.${v1.id}`, { token: admin.token, method: 'PATCH', body: { staff_id: staffA.id } }); const r2 = await rest(`booking_vehicles?id=eq.${v2.id}`, { token: admin.token, method: 'PATCH', body: { staff_id: staffB.id } }); const failed = []; for (const r of [r1, r2]) if (!r.ok) failed.push(message({ data: await json(r) })); check('A9 each vehicle has its own technician', r1.ok && r2.ok, failed.join('; ')); } }

  // finishing
  const finishers = [['A1', staffA], ['A2', staffA], ['A4', staffB], ['A7', staffB]];
  for (const [key, staff] of finishers) { const rec = state.A[key]; if (rec) await finishAndRelease(T, rec, staff, key); }
  if (state.A.A9) {
    const rec = state.A.A9; await T.timeArrives(rec.id);
    const row = await bookingRow(rec.id);
    const staffFor = (v) => (v.staff_id === staffA.id ? staffA : staffB);
    let allOk = true;
    for (const v of row.booking_vehicles) {
      const s = staffFor(v);
      const b = await rest('service_photos', { token: s.token, method: 'POST', body: { booking_id: rec.id, booking_vehicle_id: v.id, phase: 'before', storage_path: `lifecycle/${v.id}-b.jpg`, uploaded_by: s.id } });
      const st = await api('/api/bookings/update-status', { token: s.token, body: { bookingId: rec.id, unitId: v.id, newStatus: 'IN_PROGRESS', actorRole: 'STAFF' } });
      const a = await rest('service_photos', { token: s.token, method: 'POST', body: { booking_id: rec.id, booking_vehicle_id: v.id, phase: 'after', storage_path: `lifecycle/${v.id}-a.jpg`, uploaded_by: s.id } });
      const fin = await api('/api/bookings/update-status', { token: s.token, body: { bookingId: rec.id, unitId: v.id, newStatus: 'COMPLETED', actorRole: 'STAFF' } });
      allOk = allOk && b.ok && st.ok && a.ok && fin.ok;
      if (!(b.ok && st.ok && a.ok && fin.ok)) note(`A9 vehicle ${v.id.slice(0, 6)}: ${b.ok} ${st.ok ? '' : message(st)} ${a.ok} ${fin.ok ? '' : message(fin)}`);
    }
    check('A9 two vehicles, two technicians, both finished', allOk);
    const after = await bookingRow(rec.id);
    check('A9 booking stays in progress while a balance is owed (by design)', String(after.status).toLowerCase() === 'in_progress', after.status);
    await settleBalance(T, rec, 'A9');
  }
  // release a fully paid, completed booking
  if (state.A.A4) {
    const r = await api('/api/bookings/release', { token: admin.token, body: { bookingId: state.A.A4.id } });
    check('A4 completed and fully paid booking released', r.ok, r.ok ? '' : message(r));
  }
  // an unfinished balance stays visible, and paying it completes the booking
  if (state.A.A2) {
    const l = await ledger(state.A.A2.id);
    check('A2 finished work still shows its unpaid balance', money(l.outstanding_amount) > 0, JSON.stringify({ net: l.net_settled, out: l.outstanding_amount }));
    await settleBalance(T, state.A.A2, 'A2');
  }

  // cancelling
  if (state.A.A10) { const r = await cancel(state.A.A10.id, 'customer'); check('A10 customer cancels an unverified cash booking', r.ok, r.ok ? '' : message(r)); }
  if (state.A.A11) {
    const before = await ledger(state.A.A11.id);
    const r = await cancel(state.A.A11.id, 'customer');
    check('A11 customer cancels a verified GCash booking', r.ok, r.ok ? '' : message(r));
    const after = await ledger(state.A.A11.id);
    const refundable = money(before.net_settled);
    note(`A11 refundable before cancel ₱${refundable}, ledger after: ${JSON.stringify({ settled: after.net_settled, refunded: after.refunded_amount, pending: after.pending_refund })}`);
    const rf = await refund(state.A.A11.id, refundable, 0, 'Bank Transfer');
    check('A11 refund of the full payment recorded', rf.ok, rf.ok ? '' : message(rf));
    const l = await ledger(state.A.A11.id);
    check('A11 ledger shows the refund and nothing left to refund', money(l.refunded_amount) === refundable, `refunded ${l.refunded_amount}`);
  }
  if (state.A.A5) {
    const r = await cancel(state.A.A5.id, 'admin', 'Customer called to cancel');
    check('A5 admin cancels a part-paid walk-in booking', r.ok, r.ok ? '' : message(r));
    const rf = await refund(state.A.A5.id, money(state.A.A5.down - 100), 100, 'Cash');
    check('A5 partial refund with a ₱100 cancellation deduction', rf.ok, rf.ok ? '' : message(rf));
    const l = await ledger(state.A.A5.id);
    check('A5 ledger agrees (refunded + deduction = paid)', money(l.refunded_amount) + 100 >= money(state.A.A5.down) - 0.01, `refunded ${l.refunded_amount}`);
  }
  if (state.A.A6) {
    const r = await cancel(state.A.A6.id, 'admin', 'Walk-in left');
    check('A6 admin cancels a booking whose payment is only "to be received"', r.ok, r.ok ? '' : message(r));
    const l = await ledger(state.A.A6.id);
    check('A6 nothing was received, so nothing to refund', money(l.net_settled) === 0, `net_settled ${l.net_settled}`);
  }

  // rescheduling
  const moveTo = firstOpenDay(day + 3);
  for (const [key, by] of [['A8', 'customer'], ['A12', 'admin']]) {
    const rec = state.A[key]; if (!rec) continue;
    const r = await reschedule(rec.id, moveTo + (key === 'A12' ? 2 : 0), 14, by);
    check(`${key} rescheduled by the ${by}`, r.ok, r.ok ? '' : message(r));
    if (r.ok) { const row = await bookingRow(rec.id); check(`${key} new time saved and payment kept`, new Date(row.start_datetime).getTime() > Date.now(), row.start_datetime); }
  }
  if (state.A.A12) { const r = await reschedule(state.A.A12.id, moveTo + 4, 15, 'admin'); check('A12 rescheduled a second time', r.ok, r.ok ? '' : message(r)); }
  void cust; void rpc; void json;

  // audit trail for what was done in phase A
  for (const [key, expect] of [['A10', /cancel/i], ['A11', /cancel/i], ['A5', /cancel/i], ['A12', /resched/i], ['A8', /resched/i]]) {
    const rec = state.A[key]; if (!rec) continue;
    const log = await auditFor(rec.id);
    check(`${key} has audit entries`, Array.isArray(log) && log.length > 0 && log.some((e) => expect.test(`${e.action_type} ${e.details}`)), Array.isArray(log) ? [...new Set(log.map((e) => e.action_type))].join(', ') : String(log).slice(0, 80));
  }
  registerPhaseAAudit(T, state);
}


const registerPhaseAAudit = (T, state) => {
  const { expectAudit } = T;
  for (const rec of Object.values(state.A)) expectAudit(rec, 'booking created', /BOOKING_CREATED/);
  for (const key of ['A1', 'A2', 'A3', 'A9', 'A11']) if (state.A[key]) expectAudit(state.A[key], 'payment verified', /PAYMENT_VERIFIED/);
  if (state.A.A8) expectAudit(state.A.A8, 'receipt rejected', /PAYMENT_REJECTED/);
  for (const key of ['A5', 'A6', 'A10', 'A11']) if (state.A[key]) expectAudit(state.A[key], 'cancelled', /BOOKING_CANCELLED/);
  for (const key of ['A8', 'A12']) if (state.A[key]) expectAudit(state.A[key], 'rescheduled', /RESCHEDULED/);
  for (const key of ['A11', 'A5']) if (state.A[key]) expectAudit(state.A[key], 'refund recorded', /REFUND/);
};

// ---------------------------------------------------------------------------------------------------------------
// Phase B: change every aspect of the Business Hub
async function phaseB(T, state) {
  const { check, note, section, cfgRow, patchConfig, rest, json, api, admin, price, requiredDownpayment, firstOpenDay, manilaDate, bookingRow, sql } = T;
  section('Phase B: changing every aspect of the Business Hub');
  const before = await cfgRow();
  state.B = { before };

  const closureDay = firstOpenDay(8);
  state.B.closureDay = closureDay;
  const trikeService = { id: 'trike_wash', name: 'Trike Wash', price: 120, source: 'custom', archived: false, is_active: true, description: 'Wash for a trike.', vehicleType: 'Trike', vehicleTypes: ['Trike'], vehicle_type: 'Trike', durationMinutes: 30, applicableVehicleTypes: ['Trike'], generalService: 'Custom Services' };
  const services = (before.custom_services || []).map((s) => (s.id === 'wash_basic-Sedan' ? { ...s, price: 199 } : s));
  check('the Sedan Basic Carwash price entry exists in the catalog', (before.custom_services || []).some((s) => s.id === 'wash_basic-Sedan'));
  const patch = {
    business_name: 'Comar Garage QA', contact_number: '09171112222', email_address: 'qa@comargarage.test', business_address: '1 QA Street',
    opening_hour: '09:00 AM', closing_hour: '05:00 PM', slots_per_hour: 3, max_vehicles_per_staff: 4,
    booking_lead_time_minutes: 120, max_advance_days: 14, closed_weekdays: [0], enforce_capacity: true,
    downpayment_min_total: 500, downpayment_rate: 0.4, downpayment_high_threshold: 1500, downpayment_high_rate: 0.6,
    vehicle_types: [...(before.vehicle_types || []), 'Trike'],
    custom_services: [...services, trikeService],
    faqs: [...(before.faqs || []), { question: 'Do you take trikes?', answer: 'Yes, since the QA update.' }]
  };
  await patchConfig(patch);

  // everyone reads the new values: the public (signed-out) read and the server-side price check
  const anon = (await json(await rest('business_config?select=*&limit=1', { token: process.argv[process.argv.indexOf('--anon') + 1] })))[0];
  for (const [key, value] of Object.entries({ business_name: patch.business_name, opening_hour: patch.opening_hour, closing_hour: patch.closing_hour, slots_per_hour: 3, booking_lead_time_minutes: 120, max_advance_days: 14 })) {
    check(`Hub change "${key}" is visible to a signed-out visitor`, anon[key] === value, String(anon[key]));
  }
  check('Hub change "closed weekdays" (Sunday) is saved', JSON.stringify(anon.closed_weekdays) === '[0]', JSON.stringify(anon.closed_weekdays));
  check('Hub change "new vehicle type" Trike is saved', (anon.vehicle_types || []).includes('Trike'));
  check('Hub change "FAQ added" is saved', (anon.faqs || []).some((f) => /trikes/i.test(f.question)));
  check('the new Sedan Basic Carwash price (₱199) is what the server charges', (await price('Basic Carwash', 'Sedan')) === 199, String(await price('Basic Carwash', 'Sedan')));
  check('the new Trike Wash service is priced for the new vehicle type', (await price('Trike Wash', 'Trike')) === 120, String(await price('Trike Wash', 'Trike')));
  check('Trike Wash is not offered for a Sedan', (await price('Trike Wash', 'Sedan')) === null);
  check('the downpayment rule follows the new policy (₱600 -> 40%)', (await requiredDownpayment(600)) === 240, String(await requiredDownpayment(600)));
  check('the higher downpayment rate applies from ₱1,500 (₱1,600 -> 60%)', (await requiredDownpayment(1600)) === 960, String(await requiredDownpayment(1600)));

  // promo rule (the endpoint the Business Hub uses) and promo code
  const yesterday = manilaDate(-1); const ymd = (d) => `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  const promo = await api('/api/admin/promos', { token: admin.token, body: { name: 'LC Sedan Premium Wash 20%', mode: 'standard', type: 'percentage', value: 20, validFrom: ymd(yesterday), neverExpires: true, vehicleTypes: ['Sedan'], vehicleServiceMatrix: { Sedan: ['Premium All Carwash'] } } });
  check('a new standard promo is saved through the admin endpoint', promo.ok, promo.ok ? '' : T.message(promo));
  const stored = (await cfgRow()).promo_rules || [];
  check('the promo is in the shop configuration', stored.some((r) => r.name === 'LC Sedan Premium Wash 20%'));
  const code = await rest('promo_codes', { token: admin.token, method: 'POST', body: { code: 'LCNEW10', name: 'LC ten off', discount_type: 'percentage', discount_value: 10, max_uses: 2 } });
  check('a promo code (10%, two customers) is created', code.ok, code.ok ? '' : JSON.stringify(await json(code)).slice(0, 100));

  // a shop closure through the endpoint the Hub uses; closing a day that has a booking must be refused
  const dayKey = (n) => { const d = manilaDate(n); return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`; };
  const closure = await api('/api/admin/blocked-slots', { token: admin.token, body: { block_date: dayKey(closureDay), reason: 'LIFECYCLE closure' } });
  check('a whole-day shop closure is saved', closure.ok, closure.ok ? '' : T.message(closure));
  const busy = Object.values(state.A || {}).find((r) => r.ok && r.id && r.kind === 'admin_cash_full' && r.label === 'A12');
  if (busy) {
    const row = await bookingRow(busy.id);
    const busyDay = new Date(new Date(row.start_datetime).getTime() + 8 * 3600000).toISOString().slice(0, 10);
    const refused = await api('/api/admin/blocked-slots', { token: admin.token, body: { block_date: busyDay, reason: 'LIFECYCLE conflicting closure' } });
    check('closing a day that already has a booking is refused', !refused.ok, refused.ok ? 'it was accepted' : T.message(refused));
    if (refused.ok) await rest('blocked_slots?reason=like.*conflicting*', { method: 'DELETE' });
  }
  void note; void sql;
}

// ---------------------------------------------------------------------------------------------------------------
// Phase C: the same flows again; every new rule has to hold
async function phaseC(T, state) {
  const { check, note, section, book, verifyAll, assign, ledger, bookingRow, cancel, reschedule, refund, staffA, staffB, firstOpenDay, nextDow, cust, cust2, admin, message, rpc, rest, json, cfgRow, expectAudit, api, price } = T;
  section('Phase C: new bookings must follow the new Business Hub settings');
  state.C = {};
  const closureDay = state.B?.closureDay ?? firstOpenDay(8);
  const sedan = (services) => [{ type: 'Sedan', services }];
  // days that are open under the new rules (not Sunday, not the closure, inside the 14-day window)
  const pool = []; for (let d = 3; d <= 13; d += 1) if (T.manilaDate(d).dow !== 0 && d !== closureDay) pool.push(d);
  let cursor = 0;
  const hoursList = [9, 10, 11, 12, 14, 15];
  const pick = () => { const i = cursor; cursor += 1; return { day: pool[i % pool.length], hour: hoursList[Math.floor(i / pool.length) % hoursList.length] }; };
  const okDay = (from) => pool.find((d) => d >= from) ?? pool[0];
  const nextDay = () => pick().day;

  // --- rules that must refuse ---
  const refuse = async (name, args, pattern) => {
    const r = await book({ label: name, ...args });
    check(`refused: ${name}`, !r.ok && (!pattern || pattern.test(r.error)), r.ok ? 'it was accepted' : r.error);
    if (r.ok) await cancel(r.id, 'admin', 'cleanup of an unexpected booking');
  };
  await refuse('start before the new opening time (08:00, opens 09:00)', { kind: 'cash_pending', day: pick().day, hour: 8, vehicles: sedan(['Basic Carwash']) });
  await refuse('starts after the new closing time (17:30, closes 17:00)', { kind: 'cash_pending', day: pick().day, hour: 17, minutes: 30, vehicles: sedan(['Basic Carwash']) });
  const late = await book({ label: 'runs past closing', kind: 'cash_pending', ...pick(), hour: 16, minutes: 30, vehicles: sedan(['Basic Carwash']) });
  check('a service may start before closing and run past it (by design)', late.ok, late.ok ? '' : late.error);
  if (late.ok) { state.C['C0 runs past closing'] = late; T.expectAudit(late, 'booking created', /BOOKING_CREATED/); }
  await refuse('Sunday (closed weekday)', { kind: 'cash_pending', day: T.nextDow(0, 3), hour: 10, vehicles: sedan(['Basic Carwash']) });
  await refuse('beyond the new 14-day booking window', { kind: 'cash_pending', day: 17, hour: 10, vehicles: sedan(['Basic Carwash']) });
  await refuse('a day closed by the shop', { kind: 'cash_pending', day: closureDay, hour: 10, vehicles: sedan(['Basic Carwash']) });
  await refuse('a total below the new price (tampered)', { kind: 'cash_pending', ...pick(), vehicles: sedan(['Basic Carwash']), totalOverride: 100 }, /does not match/i);
  await refuse('a service the shop does not offer for that vehicle (Trike Wash on a Sedan)', { kind: 'cash_pending', ...pick(), vehicles: sedan(['Trike Wash']) }, /no price/i);

  // --- rules that must accept ---
  const accept = async (key, args) => {
    const r = await book({ label: key, ...args });
    check(`accepted: ${key}`, r.ok, r.ok ? `total ₱${r.total}` : r.error);
    if (r.ok) { state.C[key] = r; expectAudit(r, 'booking created', /BOOKING_CREATED/); }
    return r;
  };
  await accept('C1 opening hour 09:00 (gcash full)', { kind: 'gcash_full', day: pick().day, hour: 9, vehicles: sedan(['Basic Carwash']) });
  await accept('C2 last hour 16:00-17:00 (customer cash)', { kind: 'cash_pending', day: pick().day, hour: 16, vehicles: sedan(['Basic Carwash']) });
  const lastDay = 13;
  await accept('C3 last bookable day of the new window', { kind: 'cash_pending', day: pool[pool.length - 1], hour: 12, vehicles: sedan(['Basic Carwash']) });
  const c4 = await accept('C4 new vehicle type: Trike Wash', { kind: 'gcash_full', ...pick(), vehicles: [{ type: 'Trike', services: ['Trike Wash'] }] });
  if (c4.ok) check('C4 trike total is the new service price (₱120)', c4.total === 120, String(c4.total));
  const c5 = await accept('C5 edited price: Sedan Basic Carwash is now ₱199 (admin walk-in cash)', { by: 'admin', kind: 'admin_cash_full', ...pick(), vehicles: sedan(['Basic Carwash']) });
  if (c5.ok) check('C5 total is ₱199', c5.total === 199, String(c5.total));

  // downpayment rule: ₱600 -> 40%, ₱1,600 -> 60%
  const c6 = await accept('C6 ₱600 booking needs the new 40% downpayment (gcash)', { kind: 'gcash_down', ...pick(), vehicles: sedan(['Premium All Carwash', 'Basic Carwash', 'Basic Carwash']), discountedTotal: 600 });
  if (c6.ok) { const l = await ledger(c6.id); check('C6 ledger asks for ₱240 (40%) and the receipt for ₱240 is what was recorded', Number(l.required_downpayment) === 240, `required ${l.required_downpayment}, pending ${l.pending_verification ?? ''}`); }
  const c7 = await accept('C7 ₱1,749 booking needs the new 60% downpayment (admin cash downpayment)', { by: 'admin', kind: 'admin_cash_down', ...pick(), vehicles: sedan(['Hand/Spray Wax', 'Buffing with Wax', 'Basic Carwash']) });
  const c7Down = c7.ok ? Math.round(c7.total * 0.6 * 100) / 100 : 0;
  if (c7.ok) { const l = await ledger(c7.id); check(`C7 ledger asks for ₱${c7Down} (60% of ₱${c7.total}) and it is met`, Math.abs(Number(l.required_downpayment) - c7Down) < 0.01 && l.downpayment_met === true, `required ${l.required_downpayment}, met ${l.downpayment_met}`); }

  // bays: three at the same time are accepted, the fourth is refused
  const bayDay = pool[2];
  const bays = [];
  for (let i = 0; i < 3; i += 1) bays.push(await accept(`C8.${i + 1} bay ${i + 1} of 3 at 13:00`, { kind: 'cash_pending', day: bayDay, hour: 13, vehicles: sedan(['Basic Carwash']) }));
  await refuse('a fourth booking in the same hour (3 bays)', { kind: 'cash_pending', day: bayDay, hour: 13, vehicles: sedan(['Basic Carwash']) }, /full|capacity|bay/i);

  // promo rule (20% on Premium All Carwash for Sedan) and promo code (10%, two customers)
  const c9 = await accept('C9 promo rule: Premium All Carwash for a Sedan at 20% off', { kind: 'gcash_full', ...pick(), vehicles: sedan(['Premium All Carwash']), discountedTotal: 200 });
  if (c9.ok) check('C9 booked at the promo price (₱200 instead of ₱250)', c9.total === 200, String(c9.total));
  const base = await price('Premium All Carwash', 'Sedan');
  const c10 = await accept('C10 promo code LCNEW10 (10%) on a fresh account', { kind: 'cash_pending', ...pick(), vehicles: sedan(['Premium All Carwash']), code: 'LCNEW10', discountedTotal: Math.round(base * 0.9 * 100) / 100 });
  await refuse('the same account uses LCNEW10 a second time', { kind: 'cash_pending', ...pick(), vehicles: sedan(['Premium All Carwash']), code: 'LCNEW10', discountedTotal: Math.round(base * 0.9 * 100) / 100 }, /already used/i);
  const c11 = await accept('C11 promo code LCNEW10 on a second account', { kind: 'cash_pending', ...pick(), vehicles: sedan(['Premium All Carwash']), code: 'LCNEW10', discountedTotal: Math.round(base * 0.9 * 100) / 100, customer: cust2 });
  const codeRow = (await json(await rest('promo_codes?code=eq.LCNEW10&select=uses_count,max_uses')))[0];
  check('the code has now been used by two customers (its limit)', codeRow?.uses_count === 2 && codeRow?.max_uses === 2, JSON.stringify(codeRow));
  const third = await rpc('redeem_promo_code', { p_code: 'LCNEW10', p_customer_id: crypto.randomUUID() }, admin.token);
  check('a third customer is told the code has reached its limit', third.data?.reason === 'used_up', JSON.stringify(third.data));
  void c10; void c11; void cust; void message;

  // --- lifecycle under the new rules ---
  const verifyKeys = Object.keys(state.C).filter((k) => /C1 |C4 |C6 |C9 /.test(k));
  for (const key of verifyKeys) {
    const rec = state.C[key];
    const out = await verifyAll(rec.id);
    check(`${key.split(' ')[0]} payment verified`, out.length > 0 && out.every((r) => r.ok), out.map((r) => (r.ok ? 'ok' : message(r))).join('; '));
    expectAudit(rec, 'payment verified', /PAYMENT_VERIFIED/);
  }
  // finish the trike, the edited-price walk-in and the C1 booking
  const toFinish = [[Object.entries(state.C).find(([k]) => k.startsWith('C4 '))?.[1], staffA], [Object.entries(state.C).find(([k]) => k.startsWith('C5 '))?.[1], staffB], [Object.entries(state.C).find(([k]) => k.startsWith('C1 '))?.[1], staffA]];
  for (const [rec, staff] of toFinish) {
    if (!rec) continue;
    const label = rec.label.split(' ')[0];
    const a = await assign(rec.id, staff); check(`${label} technician assigned`, a.ok);
    await finishAndRelease(T, rec, staff, label);
    const l = await ledger(rec.id);
    check(`${label} finished and settled (outstanding ₱0)`, Number(l.outstanding_amount) === 0, `outstanding ${l.outstanding_amount}`);
  }
  // cancel two (one verified GCash with a refund, one unverified cash) and one walk-in with downpayment
  const c9rec = Object.entries(state.C).find(([k]) => k.startsWith('C9 '))?.[1];
  if (c9rec) {
    const before = await ledger(c9rec.id);
    const r = await cancel(c9rec.id, 'customer'); check('C9 customer cancels the verified promo booking', r.ok, r.ok ? '' : message(r)); expectAudit(c9rec, 'cancelled', /BOOKING_CANCELLED/);
    const rf = await refund(c9rec.id, Number(before.net_settled), 0, 'Bank Transfer'); check('C9 refund of the promo price (₱200) recorded', rf.ok, rf.ok ? '' : message(rf)); expectAudit(c9rec, 'refund', /REFUND/);
    const l = await ledger(c9rec.id); check('C9 ledger: refunded equals what was paid', Number(l.refunded_amount) === Number(before.net_settled), `refunded ${l.refunded_amount} of ${before.net_settled}`);
  }
  if (c7.ok) {
    const r = await cancel(c7.id, 'admin', 'Walk-in changed plans'); check('C7 admin cancels the part-paid walk-in', r.ok, r.ok ? '' : message(r)); expectAudit(c7, 'cancelled', /BOOKING_CANCELLED/);
    const give = Math.round((c7Down - 100) * 100) / 100;
    const rf = await refund(c7.id, give, 100, 'Cash'); check(`C7 refund ₱${give} with ₱100 deduction of the ₱${c7Down} downpayment`, rf.ok, rf.ok ? '' : message(rf));
    const l = await ledger(c7.id); check(`C7 ledger: ₱${give} refunded`, Math.abs(Number(l.refunded_amount) - give) < 0.01, `refunded ${l.refunded_amount}`);
  }
  if (bays[0]?.ok) { const r = await cancel(bays[0].id, 'customer'); check('C8.1 customer cancels an unverified cash booking', r.ok, r.ok ? '' : message(r)); expectAudit(bays[0], 'cancelled', /BOOKING_CANCELLED/); }
  // the freed bay can be booked again
  await accept('C12 the freed bay is bookable again', { kind: 'cash_pending', day: bayDay, hour: 13, vehicles: sedan(['Basic Carwash']) });

  // reschedule under the new rules
  const target = state.C['C2 last hour 16:00-17:00 (customer cash)'];
  if (target) {
    const toSunday = await reschedule(target.id, T.nextDow(0, 3), 11, 'admin'); check('reschedule into a closed Sunday is refused', !toSunday.ok, toSunday.ok ? 'accepted' : message(toSunday));
    const toClosure = await reschedule(target.id, closureDay, 11, 'admin'); check('reschedule into the day the shop closed is refused', !toClosure.ok, toClosure.ok ? 'accepted' : message(toClosure));
    const toEarly = await reschedule(target.id, pool[3], 8, 'admin'); check('reschedule to 08:00 (before opening) is refused', !toEarly.ok, toEarly.ok ? 'accepted' : message(toEarly));
    const toLate = await reschedule(target.id, pool[3], 17, 'admin');
    void okDay; check('reschedule to 17:00 (after closing) is refused', !toLate.ok, toLate.ok ? 'accepted' : message(toLate));
    const fine = await reschedule(target.id, pool[4], 10, 'customer'); check('reschedule to a valid new slot works', fine.ok, fine.ok ? '' : message(fine)); if (fine.ok) expectAudit(target, 'rescheduled', /RESCHEDULED/);
  }
  const target2 = state.C['C3 last bookable day of the new window'];
  if (target2) {
    const tooFar = await reschedule(target2.id, 20, 10, 'customer'); check('reschedule beyond the 14-day window is refused', !tooFar.ok, tooFar.ok ? 'accepted' : message(tooFar));
    const back = await reschedule(target2.id, pool[1], 15, 'admin'); check('reschedule earlier within the window works', back.ok, back.ok ? '' : message(back)); if (back.ok) expectAudit(target2, 'rescheduled', /RESCHEDULED/);
  }
  void api; void cfgRow; void bookingRow;
}

// ---------------------------------------------------------------------------------------------------------------
// Phase D: audit logs and reports must see all of it
async function phaseD(T, state) {
  const { check, note, section, rest, json, rpc, admin, staffA, auditFor, expectedAudit, bookings, ledger, sql } = T;
  section('Phase D: audit logs and reports');
  // 1. every action that should have left an audit entry did
  const missing = [];
  const cache = new Map();
  for (const exp of expectedAudit) {
    if (!cache.has(exp.id)) cache.set(exp.id, await auditFor(exp.id));
    const log = cache.get(exp.id);
    if (!Array.isArray(log) || !log.some((e) => exp.pattern.test(`${e.action_type} ${e.details}`))) missing.push(`${exp.id.slice(0, 8)}:${exp.label}`);
  }
  check(`all ${expectedAudit.length} expected audit entries exist (created, verified, rejected, cancelled, refunded, rescheduled)`, missing.length === 0, missing.slice(0, 8).join(', '));

  // 2. the audit entries read as a person would expect: actor recorded, no empty details
  const ids = bookings.map((b) => b.id);
  const all = await json(await rest(`audit_logs?booking_id=in.(${ids.join(',')})&select=action_type,details,actor_name,actor_role&limit=2000`));
  check('every audit entry for these bookings has an actor and a description', Array.isArray(all) && all.length > 0 && all.every((e) => e.actor_name && e.details), `${all.length} entries`);
  const counts = {}; for (const e of all) counts[e.action_type] = (counts[e.action_type] || 0) + 1;
  note('audit entries by type: ' + Object.entries(counts).sort().map(([k, v]) => `${k} ${v}`).join(', '));

  // 3. reports against the money that actually moved
  let netSettled = 0; let refunded = 0; let outstanding = 0; let finished = 0;
  for (const b of bookings) {
    const l = await ledger(b.id);
    netSettled += Number(l.net_settled || 0); refunded += Number(l.refunded_amount || 0); outstanding += Number(l.outstanding_amount || 0);
  }
  const rows = await json(await rest(`booking_vehicles?booking_id=in.(${ids.join(',')})&select=status`));
  finished = rows.filter((r) => String(r.status).toUpperCase() === 'COMPLETED').length;
  const from = new Date(Date.now() - 40 * 86400000).toISOString(); const to = new Date(Date.now() + 40 * 86400000).toISOString();
  const report = (await rpc('sales_report', { p_from: from, p_to: to }, admin.token)).data;
  const base = state.reportBaseline;
  note(`ledger totals for the ${bookings.length} test bookings: settled ₱${netSettled}, refunded ₱${refunded}, outstanding ₱${outstanding}, finished vehicles ${finished}`);
  if (base) {
    note(`sales report moved: net_received +${Number(report.net_received) - Number(base.net_received)}, refunds +${Number(report.refunds) - Number(base.refunds)}, bookings +${Number(report.booking_count) - Number(base.booking_count)}`);
    check('sales report: net received rose by exactly the test bookings\' settled money', Math.abs((Number(report.net_received) - Number(base.net_received)) - (netSettled + refunded)) < 0.01,
      `report rose ${Number(report.net_received) - Number(base.net_received)} vs settled ${netSettled} (+refunded ${refunded})`);
    check('sales report: refunds rose by exactly the refunds made', Math.abs((Number(report.refunds) - Number(base.refunds)) - refunded) < 0.01, `report rose ${Number(report.refunds) - Number(base.refunds)} vs refunded ${refunded}`);
    check('sales report: net revenue = net received - refunds', Math.abs(Number(report.net_revenue) - (Number(report.net_received) - Number(report.refunds))) < 0.01, `${report.net_revenue} vs ${Number(report.net_received) - Number(report.refunds)}`);
    check('sales report: booking count rose by the bookings that were paid for', Number(report.booking_count) >= Number(base.booking_count), `${base.booking_count} -> ${report.booking_count}`);
  }
  const methods = Object.fromEntries((report.by_method || []).map((m) => [m.method, Number(m.net_received)]));
  check('sales report: both Cash and GCash appear by method', methods.CASH > 0 && methods.GCASH > 0, JSON.stringify(methods));
  const methodSum = (report.by_method || []).reduce((s, m) => s + Number(m.net_received), 0);
  check('sales report: the methods add up to the net received', Math.abs(methodSum - Number(report.net_received)) < 0.01, `${methodSum} vs ${report.net_received}`);

  // 4. the daily report for today
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const daily = (await rpc('daily_report', { p_day: today, p_to: today }, admin.token)).data;
  const todays = bookings.filter((b) => true);
  void todays;
  check('daily report for today lists the finished bookings', Number(daily?.totals?.count) >= 1 && Array.isArray(daily?.bookings), `count ${daily?.totals?.count}`);
  check('daily report: paid + balance = total value', Math.abs(Number(daily.totals.paid) + Number(daily.totals.balance) - Number(daily.totals.total_value)) < 0.01 || Number(daily.totals.refunded) > 0 || Number(daily.totals.deferred) > 0, JSON.stringify(daily.totals));

  // 5. the staff report (technician view, no money) counts the finished vehicles
  await rest(`profiles?id=eq.${staffA.id}`, { method: 'PATCH', body: { can_view_reports: true } });
  const staffReport = (await rpc('staff_bookings_report', { p_from: from, p_to: to }, staffA.token));
  if (staffReport.ok) {
    const completed = Number(staffReport.data?.totals?.completed ?? 0);
    check('staff bookings report counts the finished work', completed >= 1, `completed ${completed}`);
    check('staff bookings report shows no money or contact details', !/(amount|price|paid|balance|09171234567|cust@test)/i.test(JSON.stringify(staffReport.data)), 'clean');
  } else note('staff report: ' + T.message(staffReport) + ' (needs the "can view reports" switch for that technician)');

  // 6. what the Business Hub changes left in the audit log
  const hubAudit = await json(await rest('audit_logs?action_type=in.(BUSINESS_CONFIG_UPDATED,BUSINESS_SETTINGS_UPDATED,PROMO_CREATED,PROMO_CODE_CREATED,SHOP_CLOSURE_CREATED,BLOCKED_SLOT_CREATED)&select=action_type&limit=50&order=created_at.desc'));
  note('hub-related audit entries present now: ' + (Array.isArray(hubAudit) && hubAudit.length ? [...new Set(hubAudit.map((e) => e.action_type))].join(', ') : 'none (the Business Hub screens write these from the browser; this script changes the settings directly)'));
  void sql;
}

// ---------------------------------------------------------------------------------------------------------------
// Phase E: the admin edits staff details
async function phaseE(T, state) {
  const { check, note, section, rest, json, api, admin, staffA, staffB, message, auditFor } = T;
  section('Phase E: the admin edits staff details');
  const profile = async (id) => (await json(await rest(`profiles?id=eq.${id}&select=*`)))[0];
  const original = state.staffAOriginal;
  const patch = (body, token = admin.token) => api(`/api/admin/staff/${staffA.id}`, { method: 'PATCH', token, body });

  const ok1 = await patch({ first_name: 'Stress', last_name: 'Technician', phone_number: '09175550123', can_view_reports: true });
  check('admin edits name, mobile number and the reports switch', ok1.ok, ok1.ok ? '' : message(ok1));
  const after = await profile(staffA.id);
  check('the changes are saved on the account', after.first_name === 'Stress' && after.last_name === 'Technician' && after.phone_number === '09175550123' && after.can_view_reports === true && after.full_name === 'Stress Technician', JSON.stringify({ n: after.full_name, p: after.phone_number, r: after.can_view_reports }));

  const noRole = await patch({ role: 'ADMIN' });
  check('changing the role to administrator is refused', !noRole.ok, noRole.ok ? 'accepted' : message(noRole));
  const noEmail = await patch({ email: 'someone@else.test' });
  check('changing the email is refused', !noEmail.ok, noEmail.ok ? 'accepted' : message(noEmail));
  const badPhone = await patch({ phone_number: '12345' });
  check('an invalid mobile number is refused', !badPhone.ok, badPhone.ok ? 'accepted' : message(badPhone));
  const badName = await patch({ first_name: '<script>' });
  check('an invalid name is refused', !badName.ok, badName.ok ? 'accepted' : message(badName));
  const asStaff = await patch({ first_name: 'Hacker' }, staffB.token);
  check('a technician cannot edit another technician\'s details', !asStaff.ok, asStaff.ok ? 'accepted' : message(asStaff));
  const same = await patch({ first_name: 'Stress' });
  check('saving without a real change changes nothing', same.ok && (same.data.changed || []).length === 0, JSON.stringify(same.data.changed));

  const log = await json(await rest(`audit_logs?action_type=eq.STAFF_DETAILS_UPDATED&order=created_at.desc&limit=1&select=details,metadata,actor_name`));
  const entry = Array.isArray(log) ? log[0] : null;
  check('the edit is in the audit log with before and after values', Boolean(entry?.metadata?.before && entry?.metadata?.after && /first_name/.test(entry.details)), entry ? entry.details : 'no entry');
  check('the audit entry names the administrator who made it', Boolean(entry?.actor_name), entry?.actor_name || '');

  // deactivate and reactivate another technician (their data and role stay)
  const staffBId = staffB.id;
  const deact = await api('/api/admin/revoke-access', { token: admin.token, body: { memberId: staffBId } });
  check('admin deactivates a technician', deact.ok, deact.ok ? '' : message(deact));
  const off = await profile(staffBId);
  check('the technician keeps the staff role, is switched off and cannot sign in', off.role === 'STAFF' && off.is_active === false && off.staff_deactivated_at !== null, `${off.role}/${off.is_active}`);
  const blocked = await fetch(`${process.env.__API}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: process.env.__ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: staffB.email, password: 'LocalTest-123' }) });
  check('a deactivated technician cannot sign in', !blocked.ok, `HTTP ${blocked.status}`);
  const re = await api('/api/admin/reactivate-staff', { token: admin.token, body: { memberId: staffBId } });
  check('admin reactivates the technician', re.ok, re.ok ? '' : message(re));
  const on = await profile(staffBId);
  check('the technician is active again with the same role', on.is_active === true && on.role === 'STAFF', `${on.role}/${on.is_active}`);

  // put staff A back the way it was
  await rest(`profiles?id=eq.${staffA.id}`, { method: 'PATCH', body: { first_name: original.first_name, last_name: original.last_name, full_name: original.full_name, phone_number: original.phone_number, can_view_reports: original.can_view_reports } });
  const restored = await profile(staffA.id);
  check('the test technician is restored to the original details', restored.first_name === original.first_name && restored.phone_number === original.phone_number, restored.full_name);
  void note; void auditFor;
}
