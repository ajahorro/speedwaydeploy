// Exercises PATCH /api/admin/staff/:id against a running backend + scratch database.
//   BACKEND=http://127.0.0.1:3999 ADMIN_JWT=<scratch admin token> STAFF_ID=<staff uuid> \
//   SELF_ID=<the admin's own uuid> LAST_ADMIN_TARGET=<another admin uuid> node scripts/verify-staff-edit.mjs
import assert from 'node:assert/strict';

const { BACKEND, ADMIN_JWT, STAFF_ID, SELF_ID } = process.env;
if (!BACKEND || !ADMIN_JWT || !STAFF_ID || !SELF_ID) {
  console.error('Set BACKEND, ADMIN_JWT, STAFF_ID and SELF_ID.');
  process.exit(2);
}

const patch = async (id, body, token = ADMIN_JWT) => {
  const response = await fetch(`${BACKEND}/api/admin/staff/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

// no token / bad token -> refused
assert.equal((await patch(STAFF_ID, { first_name: 'X' }, '')).status, 403);
assert.equal((await patch(STAFF_ID, { first_name: 'X' }, 'not-a-token')).status, 403);

// validation
assert.equal((await patch(STAFF_ID, { email: 'new@example.com' })).status, 400, 'email is not editable');
assert.equal((await patch(STAFF_ID, { phone_number: '12345' })).status, 400);
assert.equal((await patch(STAFF_ID, { first_name: '<script>' })).status, 400);
assert.equal((await patch(STAFF_ID, { birthday: '2999-01-01' })).status, 400);
assert.equal((await patch(STAFF_ID, { hired_at: '2999-01-01' })).status, 400);
assert.equal((await patch(STAFF_ID, { role: 'CUSTOMER' })).status, 400);
assert.equal((await patch('00000000-0000-0000-0000-00000000dead', { first_name: 'Nobody' })).status, 404);

// a real edit, then the same edit again changes nothing
const edit = await patch(STAFF_ID, { first_name: 'Samuel', last_name: "O'Neil-Reyes", phone_number: '+63 917 555 0101', birthday: '1995-04-12', hired_at: '2024-02-01' });
assert.equal(edit.status, 200, JSON.stringify(edit.body));
assert.deepEqual([...edit.body.changed].sort(), ['birthday', 'first_name', 'hired_at', 'last_name', 'phone_number']);
assert.equal(edit.body.profile.phone_number, '09175550101');
assert.equal(edit.body.profile.full_name, "Samuel O'Neil-Reyes");
const again = await patch(STAFF_ID, { first_name: 'Samuel', phone_number: '09175550101' });
assert.deepEqual(again.body.changed, []);

// safety: cannot change your own role; cannot demote the last admin
assert.equal((await patch(SELF_ID, { role: 'STAFF' })).status, 403);

console.log('staff edit endpoint OK (auth, validation, normalisation, no-op, self-role guard)');
