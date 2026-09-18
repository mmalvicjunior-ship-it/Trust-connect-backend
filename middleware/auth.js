const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "trustconnect_secret_key_change_in_production";

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = header.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "No token provided" });
    }

    if (!roles.includes(req.user.userType)) {
      return res.status(403).json({ error: "You do not have permission to perform this action" });
    }

    next();
  };
}

module.exports = { authMiddleware, requireRole, JWT_SECRET };
