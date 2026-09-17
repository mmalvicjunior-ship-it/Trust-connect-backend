const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { verifyPassword } = require('../utils/password');

test('accepts a legacy plain-text password and flags for migration', () => {
  const result = verifyPassword('legacyPassword123', 'legacyPassword123');
  assert.equal(result.valid, true);
  assert.equal(result.migrated, true);
});

test('rejects an incorrect legacy plain-text password', () => {
  const result = verifyPassword('legacyPassword123', 'wrongPassword');
  assert.equal(result.valid, false);
  assert.equal(result.migrated, false);
});

test('accepts a standard bcrypt-hashed password ($2a$ / $2b$)', () => {
  const hash = bcrypt.hashSync('mySecurePassword!', 10);
  const result = verifyPassword(hash, 'mySecurePassword!');
  assert.equal(result.valid, true);
  assert.equal(result.migrated, false);
});

test('rejects a wrong password against a bcrypt hash', () => {
  const hash = bcrypt.hashSync('mySecurePassword!', 10);
  const result = verifyPassword(hash, 'wrongPassword!');
  assert.equal(result.valid, false);
  assert.equal(result.migrated, false);
});

test('rejects null, undefined, and empty passwords safely', () => {
  assert.deepEqual(verifyPassword(null, 'secret'), { valid: false, migrated: false });
  assert.deepEqual(verifyPassword('secret', null), { valid: false, migrated: false });
  assert.deepEqual(verifyPassword('', 'secret'), { valid: false, migrated: false });
  assert.deepEqual(verifyPassword('secret', ''), { valid: false, migrated: false });
  assert.deepEqual(verifyPassword(undefined, undefined), { valid: false, migrated: false });
});

test('simulates end-to-end legacy login to bcrypt migration', async () => {
  const legacyPassword = 'oldUserPlainTextPass';
  const suppliedInput = 'oldUserPlainTextPass';

  // Step 1: User logs in with legacy plain text
  const check = verifyPassword(legacyPassword, suppliedInput);
  assert.equal(check.valid, true);
  assert.equal(check.migrated, true);

  // Step 2: Backend automatically migrates legacy password to bcrypt hash
  const salt = await bcrypt.genSalt(10);
  const migratedHash = await bcrypt.hash(suppliedInput, salt);
  assert.match(migratedHash, /^\$2[aby]?\$/);

  // Step 3: Subsequent login now verifies against the new bcrypt hash without needing migration
  const nextCheck = verifyPassword(migratedHash, suppliedInput);
  assert.equal(nextCheck.valid, true);
  assert.equal(nextCheck.migrated, false);
});
