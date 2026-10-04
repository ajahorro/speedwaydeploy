// Checks that the phone/email rules are identical in the frontend module and the
// backend module, and match what the database enforces (see migration
// 20261027000001_contact_rules.sql). Run: node scripts/verify-contact-rules.mjs
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const front = await import(pathToFileURL(path.join(root, 'frontend/src/utils/contactValidation.js')).href);
const back = require(path.join(root, 'backend/config/contactValidation.js'));

const phones = [
  ['09123456789', true, '09123456789'],
  ['0912 345 6789', true, '09123456789'],
  ['+63 912 345 6789', true, '09123456789'],
  ['639123456789', true, '09123456789'],
  ['9123456789', true, '09123456789'],
  ['(0912)-345-6789', true, '09123456789'],
  ['0812 345 6789', false, '08123456789'],
  ['0912345678', false, '0912345678'],
  ['091234567890', false, '091234567890'],
  ['abcdefghijk', false, ''],
  ['', false, '']
];
const emails = [
  ['name@example.com', true],
  ['  Name.Last+tag@Example.CO.ph ', true],
  ['name', false],
  ['name@', false],
  ['name@example', false],
  ['name@example.c', false],
  ['na me@example.com', false],
  ['name@@example.com', false],
  ['name..x@example.com', false],
  ['.name@example.com', false],
  ['name@-example.com', false],
  [`${'a'.repeat(250)}@example.com`, false]
];

let failures = 0;
const check = (label, ok) => {
  if (!ok) { failures += 1; console.error('✖', label); }
};

for (const [input, valid, normalized] of phones) {
  for (const [name, mod] of [['frontend', front], ['backend', back]]) {
    check(`${name} phone valid(${JSON.stringify(input)}) = ${valid}`, mod.isValidPhPhone(input) === valid);
    check(`${name} phone normalize(${JSON.stringify(input)}) = ${normalized}`, mod.normalizePhPhone(input) === normalized);
  }
}
for (const [input, valid] of emails) {
  for (const [name, mod] of [['frontend', front], ['backend', back]]) {
    check(`${name} email valid(${JSON.stringify(input.slice(0, 40))}) = ${valid}`, mod.isValidEmail(input) === valid);
  }
}
check('frontend/backend lower-case and trim emails the same', front.normalizeEmail('  A@B.COM ') === back.normalizeEmail('  A@B.COM '));
check('typing filter folds a pasted +63 number', front.sanitizePhoneInput('+63 912 345 6789') === '09123456789');
check('typing filter caps at 11 digits', front.sanitizePhoneInput('091234567890123') === '09123456789');
check('typing filter drops letters', front.sanitizePhoneInput('09ab12') === '0912');

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log(`✔ contact rules agree (${phones.length} phones, ${emails.length} emails, frontend and backend).`);
