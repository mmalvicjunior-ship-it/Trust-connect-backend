const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { authMiddleware } = require("../middleware/auth");

const router = express.Router();

router.get("/", authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const payments = db.collection("payments");

    const items = await payments
      .find({ customerId: new ObjectId(req.user.id) })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    const totalPaid = items
      .filter((p) => p.status === "Paid")
      .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

    res.json({ payments: items, totalPaid });
  } catch (err) {
    console.error("Get payments error:", err);
    res.status(500).json({ error: "Server error fetching payments" });
  }
});

module.exports = router;