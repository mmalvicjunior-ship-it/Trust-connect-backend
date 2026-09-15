const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { getDb } = require("../db");
const { authMiddleware, JWT_SECRET } = require("../middleware/auth");
const { notifyActivity } = require("../notifications");

const router = express.Router();
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid email or password" });
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
    console.error("Login error:", err.stack || err);
    // For debugging, include error details (remove in production)
    res.status(500).json({ error: "Server error during login", details: err.message });
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
