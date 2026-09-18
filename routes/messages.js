const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { authMiddleware } = require("../middleware/auth");
const { createNotification } = require("../notifications");

const router = express.Router();

router.get("/conversations", authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const messages = db.collection("messages");
    const me = new ObjectId(req.user.id);

    const threads = await messages
      .find({ $or: [{ senderId: me }, { receiverId: me }] })
      .sort({ createdAt: -1 })
      .toArray();

    const map = new Map();
    for (const msg of threads) {
      const other = msg.senderId.toString() === req.user.id ? msg.receiverId : msg.senderId;
      const key = other.toString();
      if (!map.has(key)) {
        map.set(key, {
          userId: other,
          lastMessage: msg.body,
          lastDate: msg.createdAt,
          unread: (!msg.read && msg.receiverId.toString() === req.user.id) ? 1 : 0,
        });
      } else {
        const entry = map.get(key);
        if (msg.receiverId.toString() === req.user.id && !msg.read) {
          entry.unread += 1;
        }
        entry.lastMessage = msg.body;
        entry.lastDate = msg.createdAt;
      }
    }

    const userIds = [...map.keys()].map((id) => (ObjectId.isValid(id) ? new ObjectId(id) : id));
    const users = userIds.length
      ? await db.collection("users").find({ _id: { $in: userIds } }, { projection: { password: 0 } }).toArray()
      : [];
    const userById = new Map(users.map((u) => [u._id.toString(), u]));

    const conversations = [...map.values()].map((c) => {
      const u = userById.get(c.userId.toString());
      return {
        userId: c.userId,
        name: u ? u.fullName || `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.email : "User",
        email: u?.email || "",
        userType: u?.userType || "",
        avatar: u?.avatar || "",
        lastMessage: c.lastMessage,
        lastDate: c.lastDate,
        unread: c.unread,
      };
    });

    res.json({ conversations });
  } catch (err) {
    console.error("Get conversations error:", err);
    res.status(500).json({ error: "Server error fetching conversations" });
  }
});

router.get("/:userId", authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const messages = db.collection("messages");
    const me = new ObjectId(req.user.id);
    const other = new ObjectId(req.params.userId);

    const items = await messages
      .find({
        $or: [
          { senderId: me, receiverId: other },
          { senderId: other, receiverId: me },
        ],
      })
      .sort({ createdAt: 1 })
      .toArray();

    await db.collection("messages").updateMany(
      { senderId: other, receiverId: me, read: false },
      { $set: { read: true } }
    );

    res.json({ messages: items });
  } catch (err) {
    console.error("Get conversation error:", err);
    res.status(500).json({ error: "Server error fetching conversation" });
  }
});

router.post("/", authMiddleware, async (req, res) => {
  try {
    const { receiverId, body, bookingId } = req.body;

    if (!receiverId || !body || !String(body).trim()) {
      return res.status(400).json({ error: "Receiver and message are required" });
    }

    const db = getDb();
    const message = {
      senderId: new ObjectId(req.user.id),
      senderName: req.user.fullName || req.user.email,
      receiverId: new ObjectId(receiverId),
      bookingId: bookingId || null,
      body: String(body).trim(),
      read: false,
      createdAt: new Date(),
    };

    const result = await db.collection("messages").insertOne(message);

    await createNotification({
      userId: receiverId,
      type: "message",
      title: "New message",
      message: `${req.user.fullName || "Someone"} sent you a message.`,
      link: "/dashboard",
    });

    res.status(201).json({ message: "Message sent", msg: { ...message, _id: result.insertedId } });
  } catch (err) {
    console.error("Send message error:", err);
    res.status(500).json({ error: "Server error sending message" });
  }
});

router.patch("/:id/read", authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    await db.collection("messages").updateOne(
      { _id: new ObjectId(req.params.id), receiverId: new ObjectId(req.user.id) },
      { $set: { read: true } }
    );
    res.json({ message: "Message marked as read" });
  } catch (err) {
    console.error("Read message error:", err);
    res.status(500).json({ error: "Server error marking message as read" });
  }
});

module.exports = router;