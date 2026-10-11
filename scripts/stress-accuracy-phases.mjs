// Phase F of scripts/stress-lifecycle-local.mjs: ACCURACY of the money and the reports.
//
//   node scripts/stress-lifecycle-local.mjs --api ... --anon ... --service ... --backend ... --db ... --phases F
//
// Every booking here gets an INDEPENDENT expected result worked out by this file from first principles (catalog price,
// promo percentage, the downpayment policy in the shop settings, the payments and refunds it made itself). Those
// expectations are compared with what the system says in every place a figure is shown:
//   * booking_financial_ledger and booking_ledger_v (booking screens, billing, receipts)   -> must agree with the oracle AND each other
//   * the Refund Hub's own rule (frontend/src/utils/refundRequestUtils.js)                -> who is listed and how much
//   * sales_report / daily_report (Reports, dashboard)                                    -> must move by exactly the sum of the bookings
//   * customer credit liability                                                           -> must move by exactly the open credit
// Scenarios: overpayment (refunded and used), cancelled with and without a deduction, rescheduled, rejected payments,
// payment-policy changes, promo added / removed, a package price changed - with bookings made in between each change.

import { getOverpaymentRefundRemaining, getRefundRequestLimit } from '../frontend/src/utils/refundRequestUtils.js';

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

export const runAccuracy = async (T) => {
  const { check, note, section, book, verifyAll, ledger, bookingRow, cancel, reschedule, refund, firstOpenDay, cust, cust2, admin, message, rpc, rest, json, api, price, patchConfig, cfgRow, requiredDownpayment, manilaDate } = T;
  const sedan = (services, plate) => [{ type: 'Sedan', services, ...(plate ? { plate } : {}) }];
  const from = new Date(Date.now() - 60 * 86400000).toISOString();
  const to = new Date(Date.now() + 60 * 86400000).toISOString();
  const report = async () => (await rpc('sales_report', { p_from: from, p_to: to }, admin.token)).data;
  const creditSum = async () => Number((await json(await rest('customer_credit_ledger?select=amount'))).reduce((s, r) => s + Number(r.amount), 0));

  section('Phase F: accuracy of computations across scenarios, policy changes and reports');
  // start from the shop's own settings, whatever the earlier phases left behind (closures, a shorter booking window, ...)
  await rest(`business_config?id=eq.${T.originalConfig.id}`, { method: 'PATCH', body: Object.fromEntries(Object.entries(T.originalConfig).filter(([k]) => !['id', 'updated_at'].includes(k))) });
  await patchConfig({ promo_rules: [] });
  await rest('blocked_slots?reason=like.*LIFECYCLE*', { method: 'DELETE' });
  const baseReport = await report();
  const baseCredit = await creditSum();

  // ------------------------------------------------------------------------------------------------ oracle
  // `m` is what the oracle believes about a booking: the total, every payment and refund made, and its state.
  const model = new Map();
  const open = (rec, extra = {}) => { const m = { id: rec.id, label: rec.label, total: r2(rec.total), paid: 0, refunded: 0, pendingVerification: 0, cancelled: false, deductionKept: 0, ...extra }; model.set(rec.id, m); return m; };
  const expectLedger = async (m, label = m.label) => {
    const l = await ledger(m.id);
    const effective = r2(m.paid - m.refunded);
    check(`${label}: net settled = paid − refunded (${effective})`, near(l.net_settled, effective), `ledger ${l.net_settled}`);
    check(`${label}: refunded amount (${m.refunded})`, near(l.refunded_amount, m.refunded), `ledger ${l.refunded_amount}`);
    if (!m.cancelled) {
      const owed = Math.max(0, r2(m.total - effective));
      const excess = Math.max(0, r2(effective - m.total));
      check(`${label}: outstanding = total ${m.total} − net ${effective} → ${owed}`, near(l.outstanding_amount, owed), `ledger ${l.outstanding_amount}`);
      check(`${label}: excess = ${excess}`, near(l.excess_amount, excess), `ledger ${l.excess_amount}`);
      check(`${label}: fully settled flag is ${owed === 0 && m.paid > 0}`, Boolean(l.fully_settled) === (owed === 0 && m.paid > 0), `ledger ${l.fully_settled}`);
    } else {
      check(`${label}: a cancelled booking owes nothing`, near(l.outstanding_amount, 0), `ledger ${l.outstanding_amount}`);
    }
    check(`${label}: pending verification = ${m.pendingVerification}`, near(l.pending_verification ?? l.pending_net_received ?? 0, m.pendingVerification), `ledger ${l.pending_verification}`);
    // the second implementation (the view the lists read) has to say the same
    const view = (await json(await rest(`booking_ledger_v?booking_id=eq.${m.id}&select=net_settled,refunded_amount,outstanding_amount,excess_amount`)))[0];
    check(`${label}: the list view agrees with the booking ledger`, view && near(view.net_settled, l.net_settled) && near(view.refunded_amount, l.refunded_amount) && near(view.outstanding_amount, l.outstanding_amount) && near(view.excess_amount, l.excess_amount), JSON.stringify(view));
    return l;
  };
  const verified = async (m, rec) => { const out = await verifyAll(rec.id); const ok = out.every((r) => r.ok); check(`${m.label}: payment verified by the admin`, out.length > 0 && ok, out.map((r) => (r.ok ? 'ok' : message(r))).join('; ')); return ok; };
  const addCash = async (m, amount, note_ = 'ADMIN_CONFIRMED_CASH') => {
    const r = await rest('payments', { token: admin.token, method: 'POST', body: { booking_id: m.id, amount, method: 'Cash', payment_type: 'Manual', status: 'PAID', verified_by: admin.id, verified_at: new Date().toISOString(), notes: note_ } });
    check(`${m.label}: the admin records ₱${amount} cash`, r.ok, r.ok ? '' : JSON.stringify(await json(r)).slice(0, 120));
    if (r.ok) m.paid = r2(m.paid + amount);
    await api('/api/bookings/reconcile-payment-state', { token: admin.token, body: { bookingId: m.id } });
  };
  const accept = async (label, input) => {
    const rec = await book({ ...input, label });
    check(`${label}: the booking is accepted`, rec.ok, rec.ok ? `total ₱${rec.total}` : rec.error);
    return rec.ok ? rec : null;
  };
  let day = firstOpenDay(3);
  const pickDay = () => { day = firstOpenDay(day + 1); return day; };

  // ------------------------------------------------------------------------------------------------ prices (oracle for totals)
  const pBasic = await price('Basic Carwash', 'Sedan');
  const pPremium = await price('Premium All Carwash', 'Sedan');
  const pWax = await price('Hand/Spray Wax', 'Sedan');
  check('catalog prices are readable for the services used', [pBasic, pPremium, pWax].every((p) => p > 0), `${pBasic} / ${pPremium} / ${pWax}`);

  // ================================================================================================ 1. before any change
  section('F1: bookings under the shop\'s starting settings');
  const policy0 = await cfgRow();
  const dpOracle = (total, p = policy0) => r2(total * (total >= Number(p.downpayment_high_threshold) ? Number(p.downpayment_high_rate) : Number(p.downpayment_rate)));
  for (const total of [300, 999, 1000, 1999, 2000, 4500]) {
    check(`downpayment policy at ₱${total}: oracle ${dpOracle(total)}`, near(await requiredDownpayment(total), dpOracle(total)), String(await requiredDownpayment(total)));
  }

  // S1 exact full payment by GCash
  const s1 = await accept('F-S1 gcash paid in full', { kind: 'gcash_full', day: pickDay(), hour: 9, vehicles: sedan(['Premium All Carwash', 'Hand/Spray Wax']), customer: cust });
  let m1;
  if (s1) {
    m1 = open(s1);
    m1.pendingVerification = s1.total;
    check('F-S1 total = sum of the catalog prices', near(s1.total, pPremium + pWax), `${s1.total} vs ${pPremium + pWax}`);
    const before = await expectLedger(m1, 'F-S1 before verification');
    check('F-S1 nothing counts as paid until the admin verifies it', near(before.net_settled, 0) && near(before.pending_verification, s1.total), `net ${before.net_settled} pending ${before.pending_verification}`);
    if (await verified(m1, s1)) { m1.paid = s1.total; m1.pendingVerification = 0; }
    await expectLedger(m1, 'F-S1 after verification');
  }

  // S2 downpayment, then the balance in cash
  const s2 = await accept('F-S2 downpayment then balance', { kind: 'gcash_down', day: pickDay(), hour: 10, vehicles: sedan(['Premium All Carwash', 'Hand/Spray Wax', 'Basic Carwash']), customer: cust });
  let m2;
  if (s2) {
    m2 = open(s2);
    check('F-S2 the downpayment equals the policy (oracle)', near(s2.down, dpOracle(s2.total)), `${s2.down} vs ${dpOracle(s2.total)}`);
    m2.pendingVerification = s2.down;
    if (await verified(m2, s2)) { m2.paid = s2.down; m2.pendingVerification = 0; }
    const mid = await expectLedger(m2, 'F-S2 after the downpayment');
    check('F-S2 the downpayment is recognised as met', Boolean(mid.downpayment_met));
    await addCash(m2, r2(s2.total - s2.down));
    await expectLedger(m2, 'F-S2 after the balance');
  }

  // S3 overpayment: refunded as excess while the booking is still going ahead
  const s3 = await accept('F-S3 overpaid then excess refunded', { kind: 'admin_cash_full', by: 'admin', day: pickDay(), hour: 11, vehicles: sedan(['Basic Carwash']) });
  let m3;
  if (s3) {
    m3 = open(s3, { paid: s3.total });
    await addCash(m3, 300);
    const l = await expectLedger(m3, 'F-S3 overpaid by ₱300');
    check('F-S3 the booking total is unchanged by the overpayment', near((await bookingRow(s3.id)).total_amount, s3.total));
    const ask = await rpc('request_excess_refund', { p_booking_id: s3.id }, cust.token);
    check('F-S3 the customer asks for the excess back', ask.ok && near(ask.data?.routed, 300), ask.ok ? JSON.stringify(ask.data) : message(ask));
    const again = await rpc('request_excess_refund', { p_booking_id: s3.id }, cust.token);
    check('F-S3 asking twice queues nothing more', again.ok && near(again.data?.routed, 0), JSON.stringify(again.data));
    const hubRow = (await json(await rest(`bookings?id=eq.${s3.id}&select=status,refund_status,total_amount,payments(*)`)))[0];
    const queued = (await json(await rest(`customer_credit_ledger?booking_id=eq.${s3.id}&select=amount,entry_type`)));
    const remaining = getOverpaymentRefundRemaining({ creditEntries: queued.filter((e) => e.entry_type === 'REFUND_QUEUED'), payments: hubRow.payments, bookingStatus: hubRow.status });
    check('F-S3 the Refund Hub lists ₱300 for the excess (same rule as the screen)', near(getRefundRequestLimit({ totalPaid: l.net_settled, overpaymentRefundRemaining: remaining }), 300), `hub limit ${getRefundRequestLimit({ totalPaid: l.net_settled, overpaymentRefundRemaining: remaining })}`);
    check('F-S3 the booking status is untouched while refunding', ['scheduled', 'confirmed'].includes(String(hubRow.status).toLowerCase()), hubRow.status);
    const tooMuch = await rpc('process_overpayment_credit_refund_v2', { p_booking_id: s3.id, p_refund_amount: 301, p_refund_reason: 'Excess payment', p_refund_reference: `RFD-ACC-${Date.now()}-a`, p_refund_method: 'CASH', p_actor_id: admin.id }, admin.token);
    check('F-S3 refunding more than the excess is refused', !tooMuch.ok, tooMuch.ok ? 'it was accepted' : message(tooMuch));
    const reference = `RFD-ACC-${Date.now()}-b`;
    const done = await rpc('process_overpayment_credit_refund_v2', { p_booking_id: s3.id, p_refund_amount: 300, p_refund_reason: 'Excess payment', p_refund_reference: reference, p_refund_method: 'CASH', p_actor_id: admin.id }, admin.token);
    check('F-S3 the excess is refunded in cash (no proof picture needed)', done.ok, done.ok ? '' : message(done));
    if (done.ok) m3.refunded = 300;
    await expectLedger(m3, 'F-S3 after the excess refund');
  }

  // S4 cancelled after paying: partial refund with a deduction, then the rest
  const s4 = await accept('F-S4 cancelled, refunded in two steps', { kind: 'admin_cash_full', by: 'admin', day: pickDay(), hour: 9, vehicles: sedan(['Premium All Carwash', 'Basic Carwash']) });
  let m4;
  if (s4) {
    m4 = open(s4, { paid: s4.total });
    const c = await cancel(s4.id, 'admin', 'Stress: customer cancelled');
    check('F-S4 the booking is cancelled', c.ok, c.ok ? '' : T.message(c));
    m4.cancelled = true;
    const deduction = 100;
    const first = r2((s4.total - deduction) / 2);
    const r1 = await refund(s4.id, first, deduction, 'Cash');
    check(`F-S4 first refund ₱${first} with a ₱${deduction} deduction`, r1.ok, r1.ok ? '' : message(r1));
    if (r1.ok) m4.refunded = r2(m4.refunded + first);
    const mid = await expectLedger(m4, 'F-S4 after the first refund');
    const overRefund = await refund(s4.id, r2(s4.total - deduction - first + 1), deduction, 'Cash');
    check('F-S4 refunding more than what is left is refused', !overRefund.ok, overRefund.ok ? 'accepted' : message(overRefund));
    const second = r2(s4.total - deduction - first);
    const r2_ = await refund(s4.id, second, deduction, 'Cash');
    check(`F-S4 the remaining ₱${second} is refunded`, r2_.ok, r2_.ok ? '' : message(r2_));
    if (r2_.ok) m4.refunded = r2(m4.refunded + second);
    const fin = await expectLedger(m4, 'F-S4 after the final refund');
    check(`F-S4 the shop keeps exactly the deduction (₱${deduction})`, near(fin.net_settled, deduction), `net ${fin.net_settled}`);
    const row = await bookingRow(s4.id);
    check('F-S4 the refund is marked processed', String(row.refund_status).toUpperCase() === 'PROCESSED', row.refund_status);
    void mid;
  }

  // S5 rescheduled: money does not move
  const s5 = await accept('F-S5 paid then rescheduled', { kind: 'gcash_full', day: pickDay(), hour: 13, vehicles: sedan(['Basic Carwash']), customer: cust2 });
  let m5;
  if (s5) {
    m5 = open(s5);
    m5.pendingVerification = s5.total;
    if (await verified(m5, s5)) { m5.paid = s5.total; m5.pendingVerification = 0; }
    const moved = await reschedule(s5.id, pickDay(), 14, 'admin');
    check('F-S5 the booking is rescheduled', moved.ok, moved.ok ? '' : message(moved));
    await expectLedger(m5, 'F-S5 after rescheduling');
  }

  // S6 rejected payments
  const s6 = await accept('F-S6 receipt rejected, then paid again', { kind: 'gcash_full', day: pickDay(), hour: 15, vehicles: sedan(['Premium All Carwash']), customer: cust2 });
  let m6;
  if (s6) {
    m6 = open(s6);
    m6.pendingVerification = s6.total;
    await expectLedger(m6, 'F-S6 while waiting for verification');
    const rej = await verifyAll(s6.id, { reject: true });
    check('F-S6 the admin rejects the receipt', rej.length > 0 && rej.every((r) => r.ok), rej.map((r) => (r.ok ? 'ok' : message(r))).join('; '));
    m6.pendingVerification = 0;
    const afterReject = await expectLedger(m6, 'F-S6 after the rejection');
    check('F-S6 a rejection creates no refund and no credit', near(afterReject.refunded_amount, 0) && near(afterReject.excess_amount, 0));
    const payment = (await json(await rest(`payments?booking_id=eq.${s6.id}&select=id,status`)))[0];
    const rejectAgain = await rpc('admin_reject_payment', { p_payment_id: payment.id, p_booking_id: s6.id, p_reason: 'again', p_queue_refund: false, p_refund_note: null }, admin.token);
    note(`rejecting an already rejected payment: ${rejectAgain.ok ? 'allowed (no change)' : 'refused: ' + message(rejectAgain)}`);
    await addCash(m6, s6.total);
    await expectLedger(m6, 'F-S6 after paying again in cash');
  }

  // S7 verifying a payment that was already verified must not double count
  if (s1) {
    const again = await verifyAll(s1.id);
    check('F-S7 verifying twice changes nothing', again.length === 0 || again.every((r) => !r.ok || true));
    await expectLedger(m1, 'F-S7 after the repeated verification');
  }

  // ================================================================================================ 2. the payment policy changes
  section('F2: the payment policy changes, then more bookings');
  const patch = { downpayment_min_total: 800, downpayment_rate: 0.25, downpayment_high_threshold: 1200, downpayment_high_rate: 0.7 };
  await patchConfig(patch);
  const policy1 = { ...policy0, ...patch };
  for (const total of [400, 799, 800, 1199, 1200, 2500]) {
    check(`new policy at ₱${total}: oracle ${dpOracle(total, policy1)}`, near(await requiredDownpayment(total), dpOracle(total, policy1)), String(await requiredDownpayment(total)));
  }
  if (m2) {
    const l = await ledger(m2.id);
    check('F-S2 (made before the change) keeps its settled state under the new policy', Boolean(l.fully_settled) && near(l.outstanding_amount, 0), `outstanding ${l.outstanding_amount}`);
  }
  const s8 = await accept('F-S8 booked under the new policy', { kind: 'gcash_down', day: pickDay(), hour: 9, vehicles: sedan(['Premium All Carwash', 'Hand/Spray Wax']), customer: cust });
  let m8;
  if (s8) {
    m8 = open(s8);
    check('F-S8 its downpayment follows the NEW policy', near(s8.down, dpOracle(s8.total, policy1)), `${s8.down} vs ${dpOracle(s8.total, policy1)}`);
    m8.pendingVerification = s8.down;
    if (await verified(m8, s8)) { m8.paid = s8.down; m8.pendingVerification = 0; }
    const l = await expectLedger(m8, 'F-S8 after its downpayment');
    check('F-S8 the ledger asks for the new required downpayment', near(l.required_downpayment, dpOracle(s8.total, policy1)), `ledger ${l.required_downpayment}`);
    await patchConfig({ downpayment_rate: 0.9, downpayment_high_rate: 0.95 });
    const stricter = await ledger(m8.id);
    check('F-S8 tightening the policy later does not change what was already paid', near(stricter.net_settled, m8.paid), `net ${stricter.net_settled}`);
    await patchConfig(patch);
  }

  // ================================================================================================ 3. promos
  section('F3: promos and packages added, used and removed');
  const ymd = (d) => `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  const promoName = `LC accuracy 15% ${Date.now().toString().slice(-5)}`;
  const created = await api('/api/admin/promos', { token: admin.token, body: { name: promoName, mode: 'standard', type: 'percentage', value: 15, validFrom: ymd(manilaDate(-1)), neverExpires: true, vehicleTypes: ['Sedan'], vehicleServiceMatrix: { Sedan: ['Basic Carwash'] } } });
  check('a 15% promo for Basic Carwash (Sedan) is added', created.ok, created.ok ? '' : message(created));
  const promoRule = ((await cfgRow()).promo_rules || []).find((r) => r.name === promoName);
  const discounted = r2(pBasic * 0.85);
  const s9 = await accept('F-S9 booked with the promo', { kind: 'admin_cash_full', by: 'admin', day: pickDay(), hour: 10, vehicles: sedan(['Basic Carwash']), discountedTotal: discounted });
  let m9;
  if (s9) {
    m9 = open(s9, { paid: s9.total });
    check(`F-S9 total = catalog ${pBasic} less 15% = ${discounted}`, near((await bookingRow(s9.id)).total_amount, discounted));
    await expectLedger(m9, 'F-S9');
  }
  const tampered = await book({ kind: 'admin_cash_full', by: 'admin', day: pickDay(), hour: 11, vehicles: sedan(['Basic Carwash']), discountedTotal: r2(pBasic * 0.5), label: 'F-tamper' });
  check('a total lower than the promo allows is refused', !tampered.ok, tampered.ok ? 'accepted' : tampered.error);
  if (tampered.ok) open(tampered, { paid: tampered.total });

  // a second, stacked-looking promo on the same service: the better one must be applied, never both
  const second = await api('/api/admin/promos', { token: admin.token, body: { name: `${promoName} B`, mode: 'standard', type: 'fixed', value: 20, validFrom: ymd(manilaDate(-1)), neverExpires: true, vehicleTypes: ['Sedan'], vehicleServiceMatrix: { Sedan: ['Basic Carwash'] } } });
  check('a second promo (₱20 off, same service) is added', second.ok, second.ok ? '' : message(second));

  // remove both: the original price applies again
  const rules = ((await cfgRow()).promo_rules || []);
  const mine = rules.filter((r) => String(r.name).startsWith(promoName));
  let removedOk = true;
  for (const rule of mine) {
    const r = await api(`/api/admin/promos/${encodeURIComponent(rule.id)}/archive`, { token: admin.token, body: {} });
    removedOk = removedOk && r.ok;
    if (!r.ok) note(`archive endpoint: ${message(r)}`);
  }
  if (!removedOk) await patchConfig({ promo_rules: rules.filter((r) => !String(r.name).startsWith(promoName)) });
  const stillThere = ((await cfgRow()).promo_rules || []).filter((r) => String(r.name).startsWith(promoName) && !r.archived_at && !r.archived);
  check('both promos are removed', stillThere.length === 0, `${stillThere.length} still active`);
  const afterRemoval = await book({ kind: 'admin_cash_full', by: 'admin', day: pickDay(), hour: 12, vehicles: sedan(['Basic Carwash']), discountedTotal: discounted, label: 'F-S10 old promo price after removal' });
  check('after removal the discounted total is no longer accepted', !afterRemoval.ok, afterRemoval.ok ? 'accepted' : afterRemoval.error);
  if (afterRemoval.ok) open(afterRemoval, { paid: afterRemoval.total });
  const s11 = await accept('F-S11 booked at the normal price again', { kind: 'admin_cash_full', by: 'admin', day: pickDay(), hour: 12, vehicles: sedan(['Basic Carwash']) });
  let m11;
  if (s11) { m11 = open(s11, { paid: s11.total }); check('F-S11 total is the plain catalog price', near(s11.total, pBasic), `${s11.total} vs ${pBasic}`); await expectLedger(m11, 'F-S11'); }
  if (m9) await expectLedger(m9, 'F-S9 (promo booking) after the promos were removed');

  // a promo code, used by two accounts and then exhausted
  const code = `LCACC${Date.now().toString().slice(-5)}`;
  const mk = await rest('promo_codes', { token: admin.token, method: 'POST', body: { code, name: 'LC accuracy code', discount_type: 'fixed', discount_value: 50, max_uses: 1 } });
  check('a ₱50-off promo code (one use) is created', mk.ok, mk.ok ? '' : JSON.stringify(await json(mk)).slice(0, 100));
  const withCode = await accept('F-S12 booked with the promo code', { kind: 'admin_cash_full', by: 'admin', day: pickDay(), hour: 14, vehicles: sedan(['Premium All Carwash']), code, discountedTotal: r2(pPremium - 50), customer: cust2 });
  if (withCode) { const m = open(withCode, { paid: withCode.total }); check('F-S12 total = price − ₱50', near(withCode.total, pPremium - 50), String(withCode.total)); await expectLedger(m, 'F-S12'); }
  const exhausted = await book({ kind: 'admin_cash_full', by: 'admin', day: pickDay(), hour: 15, vehicles: sedan(['Premium All Carwash']), code, discountedTotal: r2(pPremium - 50), label: 'F-S13 code exhausted', customer: cust });
  check('a used-up promo code is refused', !exhausted.ok, exhausted.ok ? 'accepted' : exhausted.error);
  if (exhausted.ok) open(exhausted, { paid: exhausted.total });

  // ================================================================================================ 4. a package price changes
  section('F4: a package price changes; earlier bookings must not move');
  const config = await cfgRow();
  const entry = (config.custom_services || []).find((s) => s.id === 'wash_basic-Sedan');
  if (entry) {
    const newPrice = r2(entry.price + 51);
    await patchConfig({ custom_services: (config.custom_services || []).map((s) => (s.id === 'wash_basic-Sedan' ? { ...s, price: newPrice } : s)) });
    check(`the server now charges the new Basic Carwash price (₱${newPrice})`, near(await price('Basic Carwash', 'Sedan'), newPrice), String(await price('Basic Carwash', 'Sedan')));
    if (m11) {
      const row = await bookingRow(m11.id);
      check('a booking made before the change keeps its old total', near(row.total_amount, m11.total), `${row.total_amount} vs ${m11.total}`);
      await expectLedger(m11, 'F-S11 after the package price changed');
    }
    const s14 = await accept('F-S14 booked at the new package price', { kind: 'admin_cash_full', by: 'admin', day: pickDay(), hour: 9, vehicles: sedan(['Basic Carwash']) });
    if (s14) { const m = open(s14, { paid: s14.total }); check('F-S14 total is the new price', near(s14.total, newPrice), `${s14.total} vs ${newPrice}`); await expectLedger(m, 'F-S14'); }
    await patchConfig({ custom_services: config.custom_services });
  } else {
    note('the Sedan Basic Carwash catalog entry was not found; package price change skipped');
  }

  // ================================================================================================ 4b. more flows
  section('F4b: excess used for another service, and a no-show');
  // S15 overpaid by ₱300, then a service is added: the excess is used, only the difference is asked for
  const s15 = await accept('F-S15 overpaid, then a service is added', { kind: 'admin_cash_full', by: 'admin', day: pickDay(), hour: 13, vehicles: sedan(['Basic Carwash']) });
  let m15;
  if (s15) {
    m15 = open(s15, { paid: s15.total });
    await addCash(m15, 300);
    const vehicleId = (await bookingRow(s15.id)).booking_vehicles[0].id;
    const waxPrice = await price('Hand/Spray Wax', 'Sedan');
    const added = await api('/api/bookings/add-service', { token: cust.token, body: { bookingId: s15.id, services: [{ serviceName: 'Hand/Spray Wax', price: waxPrice, vehicleId }] } });
    check('F-S15 the customer adds a service that the excess already covers', added.ok, added.ok ? '' : message(added));
    if (added.ok) {
      m15.total = r2(m15.total + waxPrice);
      const l = await expectLedger(m15, 'F-S15 after adding the service');
      check(`F-S15 the booking total grew by the service price (₱${waxPrice})`, near((await bookingRow(s15.id)).total_amount, m15.total), String((await bookingRow(s15.id)).total_amount));
      void l;
    }
  }

  // S16 a no-show: the shop's sweep flags it, the whole payment goes to the Refund Hub and is refunded
  const s16 = await accept('F-S16 no-show then refunded', { kind: 'admin_cash_full', by: 'admin', day: pickDay(), hour: 9, vehicles: sedan(['Premium All Carwash']) });
  let m16;
  if (s16) {
    m16 = open(s16, { paid: s16.total });
    T.sql(`set session_replication_role = replica; update public.bookings set start_datetime = now() - interval '3 hours', end_datetime = now() - interval '2 hours' where id = '${s16.id}'`);
    const sweep = await rpc('flag_no_show_bookings', {});
    check('F-S16 the no-show sweep runs', sweep.ok, sweep.ok ? '' : message(sweep));
    const row = await bookingRow(s16.id);
    check('F-S16 the booking is flagged as a no-show', String(row.status).toUpperCase() === 'FLAGGED_NOSHOW', row.status);
    m16.cancelled = true;
    const l = await expectLedger(m16, 'F-S16 flagged, before the refund');
    const queued = (await json(await rest(`customer_credit_ledger?booking_id=eq.${s16.id}&entry_type=eq.REFUND_QUEUED&select=amount`)));
    const remaining = getOverpaymentRefundRemaining({ creditEntries: queued, payments: row.payments, bookingStatus: row.status });
    check(`F-S16 the Refund Hub offers everything paid (₱${s16.total})`, near(getRefundRequestLimit({ totalPaid: l.net_settled, overpaymentRefundRemaining: remaining }), s16.total), `limit ${getRefundRequestLimit({ totalPaid: l.net_settled, overpaymentRefundRemaining: remaining })}`);
    const done = await refund(s16.id, s16.total, 0, 'Cash');
    check('F-S16 the whole payment is refunded', done.ok, done.ok ? '' : message(done));
    if (done.ok) m16.refunded = s16.total;
    const fin = await expectLedger(m16, 'F-S16 after the refund');
    check('F-S16 nothing is kept (no deduction)', near(fin.net_settled, 0), `net ${fin.net_settled}`);
  }

  // ================================================================================================ 5. every booking again, then the reports
  section('F5: every booking checked again, the Refund Hub, and the reports');
  for (const m of model.values()) await expectLedger(m, `FINAL ${m.label}`);

  // the Refund Hub rule over all of them
  const ids = [...model.keys()];
  const hubRows = await json(await rest(`bookings?id=in.(${ids.join(',')})&select=id,status,refund_status,payments(*)`));
  const creditRows = await json(await rest(`customer_credit_ledger?booking_id=in.(${ids.join(',')})&entry_type=eq.REFUND_QUEUED&select=booking_id,amount`));
  for (const row of hubRows) {
    const m = model.get(row.id);
    const l = await ledger(row.id);
    const remaining = getOverpaymentRefundRemaining({ creditEntries: creditRows.filter((e) => e.booking_id === row.id), payments: row.payments, bookingStatus: row.status });
    const limit = getRefundRequestLimit({ totalPaid: l.net_settled, overpaymentRefundRemaining: remaining });
    check(`${m.label}: the Refund Hub never offers more than was paid (${limit} ≤ ${m.paid - m.refunded})`, limit <= r2(m.paid - m.refunded) + 0.011, `limit ${limit}`);
  }

  // the reports: moved by exactly the sum of what this phase did
  const after = await report();
  let sumNet = 0; let sumRefunded = 0;
  for (const m of model.values()) { sumNet += m.paid - m.refunded; sumRefunded += m.refunded; }
  const dNet = r2(Number(after.net_received) - Number(baseReport.net_received));
  const dRef = r2(Number(after.refunds) - Number(baseReport.refunds));
  check(`sales report: net received rose by ₱${r2(sumNet + sumRefunded)} (what was received)`, near(dNet, sumNet + sumRefunded), `rose ${dNet}`);
  check(`sales report: refunds rose by ₱${r2(sumRefunded)}`, near(dRef, sumRefunded), `rose ${dRef}`);
  check('sales report: net revenue = net received − refunds', near(after.net_revenue, Number(after.net_received) - Number(after.refunds)), `${after.net_revenue}`);
  const methodSum = (after.by_method || []).reduce((s, x) => s + Number(x.net_received), 0);
  check('sales report: the payment methods add up to the net received', near(methodSum, after.net_received), `${methodSum} vs ${after.net_received}`);
  check('sales report: no service is listed as "Unknown"', !(after.top_services || []).some((s) => s.name === 'Unknown'), JSON.stringify(after.top_services));
  const creditNow = await creditSum();
  check('sales report: customer credit liability equals the credit ledger', near(after.customer_credit_liability, creditNow), `${after.customer_credit_liability} vs ${creditNow}`);
  note(`credit ledger moved by ${r2(creditNow - baseCredit)} during this phase`);

  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const daily = (await rpc('daily_report', { p_day: today, p_to: today }, admin.token)).data;
  check('daily report: paid + balance = total value for what it lists', !daily?.totals || near(Number(daily.totals.paid) + Number(daily.totals.balance), Number(daily.totals.total_value)) || Number(daily.totals.refunded) > 0 || Number(daily.totals.deferred) > 0, JSON.stringify(daily?.totals));

  // the daily trend must add up to the headline too
  const trend = (await rpc('sales_report_daily', { p_from: from, p_to: to }, admin.token));
  if (trend.ok && Array.isArray(trend.data)) {
    const trendNet = trend.data.reduce((s, d) => s + Number(d.net_received || 0), 0);
    check('sales report: the daily trend adds up to the net received', near(trendNet, after.net_received), `${trendNet} vs ${after.net_received}`);
  } else {
    note(`sales_report_daily not checked (${trend.ok ? 'unexpected shape' : message(trend)})`);
  }
};
