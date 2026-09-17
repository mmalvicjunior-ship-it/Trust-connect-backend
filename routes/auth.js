const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { OAuth2Client } = require("google-auth-library");
const { getDb } = require("../db");
const { authMiddleware, JWT_SECRET } = require("../middleware/auth");
const { notifyActivity } = require("../notifications");
const { verifyPassword } = require("../utils/password");

const router = express.Router();
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const googleClient = new OAuth2Client();

router.post("/register", async (req, res) => {
  try {
    const { firstName, lastName, email, phone, password, userType } = req.body;
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const normalizedUserType = userType || "client";

    if (!firstName || !lastName || !email || !password) {
      return res.status(400).json({ error: "First name, last name, email and password are required" });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ error: "Please provide a valid email address" });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    if (!["client", "provider"].includes(normalizedUserType)) {
      return res.status(400).json({ error: "Invalid account type" });
    }

    const db = getDb();
    const users = db.collection("users");

    const existing = await users.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = {
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`,
      email: normalizedEmail,
      phone: phone || "",
      password: hashedPassword,
      userType: normalizedUserType,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await users.insertOne(user);

    const token = jwt.sign(
      { id: result.insertedId, email: user.email, userType: user.userType, providerId: user.providerId || null },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    await notifyActivity({
      type: "register",
      user: { ...user, _id: result.insertedId },
      details: { firstName: user.firstName, lastName: user.lastName },
    });

    res.status(201).json({
      token,
      user: {
        id: result.insertedId,
        firstName: user.firstName,
        lastName: user.lastName,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        userType: user.userType,
      },
    });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Server error during registration" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = String(email || "").trim().toLowerCase();

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const db = getDb();
    const users = db.collection("users");

    const user = await users.findOne({
      email: { $regex: `^${escapeRegex(normalizedEmail)}$`, $options: "i" },
    });
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const passwordCheck = verifyPassword(user.password, password);
    if (!passwordCheck.valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Auto-migrate legacy plain-text password to bcrypt hash upon successful login
    if (passwordCheck.migrated && user.password && !user.password.startsWith("$2")) {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);
      await users.updateOne({ _id: user._id }, { $set: { password: hashedPassword, updatedAt: new Date() } });
    }

    const token = jwt.sign(
      { id: user._id, email: user.email, userType: user.userType, providerId: user.providerId || null },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    await notifyActivity({
      type: "login",
      user,
      details: { method: "password" },
    });

    res.json({
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        userType: user.userType,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error during login" });
  }
});

router.post("/google", async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential || !process.env.GOOGLE_CLIENT_ID) {
      return res.status(503).json({ error: "Google sign-in is not configured" });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const profile = ticket.getPayload();
    if (!profile?.sub || !profile.email || !profile.email_verified) {
      return res.status(401).json({ error: "Google account could not be verified" });
    }

    const db = getDb();
    const users = db.collection("users");
    const normalizedEmail = profile.email.trim().toLowerCase();
    let user = await users.findOne({
      email: { $regex: `^${escapeRegex(normalizedEmail)}$`, $options: "i" },
    });

    if (!user) {
      const result = await users.insertOne({
        firstName: profile.given_name || profile.name?.split(" ")[0] || "Google",
        lastName: profile.family_name || profile.name?.split(" ").slice(1).join(" ") || "User",
        fullName: profile.name || normalizedEmail,
        email: normalizedEmail,
        phone: "",
        password: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10),
        userType: "client",
        authProvider: "google",
        googleId: profile.sub,
        avatar: profile.picture || "",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      user = { _id: result.insertedId, ...await users.findOne({ _id: result.insertedId }) };
    }

    const token = jwt.sign(
      { id: user._id, email: user.email, userType: user.userType, providerId: user.providerId || null },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        userType: user.userType,
      },
    });
  } catch (err) {
    console.error("Google login error:", err);
    res.status(401).json({ error: "Google sign-in failed" });
  }
});

router.get("/me", authMiddleware, async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    const db = getDb();
    const users = db.collection("users");

    const user = await users.findOne(
      { _id: new ObjectId(req.user.id) },
      { projection: { password: 0 } }
    );

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        userType: user.userType,
        createdAt: user.createdAt,
      },
    });
  } catch (err) {
    console.error("Me error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
