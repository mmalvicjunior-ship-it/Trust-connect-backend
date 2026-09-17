const bcrypt = require('bcryptjs');

function verifyPassword(storedPassword, suppliedPassword) {
  if (storedPassword === undefined || storedPassword === null || suppliedPassword === undefined || suppliedPassword === null) {
    return { valid: false, migrated: false };
  }

  const rawStored = String(storedPassword);
  const rawSupplied = String(suppliedPassword);
  const trimmedStored = rawStored.trim();
  const trimmedSupplied = rawSupplied.trim();

  // Strip leading/trailing matching quotes if present (e.g. from JSON seeds or raw CSV imports)
  const unquotedStored = trimmedStored.replace(/^["'](.*)["']$/, '$1');

  if (!trimmedStored || !trimmedSupplied) {
    return { valid: false, migrated: false };
  }

  // 1. Check if storedPassword matches bcrypt hash pattern ($2a$, $2b$, $2y$, $2x$, $2$)
  if (/^\$2[abyx]?\$/.test(trimmedStored)) {
    try {
      const valid = bcrypt.compareSync(rawSupplied, trimmedStored) || bcrypt.compareSync(trimmedSupplied, trimmedStored);
      if (valid) {
        return { valid: true, migrated: false };
      }
    } catch {
      // Fall through to plain text comparison if bcrypt.compare fails
    }
  }

  // 2. Legacy Plain-Text comparisons (exact, trimmed, unquoted)
  const isPlainTextMatch =
    rawStored === rawSupplied ||
    trimmedStored === trimmedSupplied ||
    unquotedStored === rawSupplied ||
    unquotedStored === trimmedSupplied;

  if (isPlainTextMatch) {
    return { valid: true, migrated: true };
  }

  return { valid: false, migrated: false };
}

module.exports = { verifyPassword };
