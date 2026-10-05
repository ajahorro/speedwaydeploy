// The emailed Statement of Account must say how much of the balance is "to be received" (deferred by
// an administrator, not money received), and must not mention it when there is none.
import assert from 'node:assert/strict';
import { buildStatementOfAccountPdf } from '../supabase/functions/_shared/statementOfAccountPdf.ts';

const decode = (b64) => Buffer.from(b64, 'base64').toString('latin1');
const ledger = (deferred) => ({ expected_amount: 1000, settled_amount: 400, net_settled: 400, outstanding_amount: 600, refunded_amount: 0, excess_amount: 0, deferred_amount: deferred });
const pdf = (deferred) => decode(buildStatementOfAccountPdf({ transactions: [], ledger: ledger(deferred) }));

assert.ok(pdf(500).includes('is marked to be received by the shop'), 'deferred line present');
assert.ok(!pdf(0).includes('marked to be received'), 'no deferred line when nothing is deferred');
assert.ok(pdf(0).includes('BALANCE DUE'), 'statement still renders');
console.log('statement PDF OK (deferred line shown only when something is deferred)');
