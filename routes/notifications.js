const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { authMiddleware } = require("../middleware/auth");

const router = express.Router();

router.get("/", authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const notifications = db.collection("notifications");

    const items = await notifications
      .find({ userId: new ObjectId(req.user.id) })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    const unread = items.filter((n) => !n.read).length;

    res.json({ notifications: items, unread });
  } catch (err) {
    console.error("Get notifications error:", err);
    res.status(500).json({ error: "Server error fetching notifications" });
  }
});

router.post("/read-all", authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    await db.collection("notifications").updateMany(
      { userId: new ObjectId(req.user.id), read: false },
      { $set: { read: true } }
    );
    res.json({ message: "All notifications marked as read" });
  } catch (err) {
    console.error("Read all notifications error:", err);
    res.status(500).json({ error: "Server error marking notifications as read" });
  }
});

router.patch("/:id/read", authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    await db.collection("notifications").updateOne(
      { _id: new ObjectId(req.params.id), userId: new ObjectId(req.user.id) },
      { $set: { read: true } }
    );
    res.json({ message: "Notification marked as read" });
  } catch (err) {
    console.error("Read notification error:", err);
    res.status(500).json({ error: "Server error marking notification as read" });
  }
});

module.exports = router;