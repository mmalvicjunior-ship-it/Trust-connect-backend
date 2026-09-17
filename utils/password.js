const bcrypt = require('bcryptjs');

function verifyPassword(storedPassword, suppliedPassword) {
  if (!storedPassword || !suppliedPassword) {
    return { valid: false, migrated: false };
  }

  // Check if storedPassword matches bcrypt hash pattern ($2a$, $2b$, $2y$, $2x$, $2$)
  if (/^\$2[abyx]?\$/.test(storedPassword)) {
    try {
      const valid = bcrypt.compareSync(suppliedPassword, storedPassword);
      return { valid, migrated: false };
    } catch {
      // Fall through to plain text comparison if bcrypt.compare fails
    }
  }

  const valid = storedPassword === suppliedPassword;
  return { valid, migrated: valid };
}

module.exports = { verifyPassword };
