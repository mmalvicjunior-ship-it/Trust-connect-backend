const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { authMiddleware } = require("../middleware/auth");

const router = express.Router();

router.post("/", authMiddleware, async (req, res) => {
  try {
    const { bookingId, subjectId, reason, details } = req.body;

    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: "A reason is required" });
    }

    const report = {
      reporterId: new ObjectId(req.user.id),
      reporterName: req.user.fullName || req.user.email,
      bookingId: bookingId || null,
      subjectId: subjectId ? new ObjectId(subjectId) : null,
      reason: String(reason).trim(),
      details: details || "",
      status: "Open",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await getDb().collection("reports").insertOne(report);

    res.status(201).json({ message: "Report submitted", report: { ...report, _id: result.insertedId } });
  } catch (err) {
    console.error("Create report error:", err);
    res.status(500).json({ error: "Server error submitting report" });
  }
});

module.exports = router;