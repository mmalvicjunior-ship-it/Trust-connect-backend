const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { authMiddleware, requireRole } = require("../middleware/auth");
const { notifyActivity, createNotification } = require("../notifications");

const router = express.Router();

router.use(authMiddleware, requireRole("admin"));

const VALID_STATUSES = [
  "Pending",
  "Accepted",
  "Rejected",
  "Confirmed",
  "In Progress",
  "Completed",
  "Cancelled",
];

const VALID_USER_TYPES = ["client", "provider", "admin"];

/* ---------------- Users ---------------- */
router.get("/users", async (req, res) => {
  try {
    const { role, q } = req.query;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    const filter = {};
    if (role && VALID_USER_TYPES.includes(role)) filter.userType = role;
    if (q) {
      const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ email: rx }, { fullName: rx }, { firstName: rx }, { lastName: rx }];
    }

    const users = getDb().collection("users");
    const total = await users.countDocuments(filter);
    const items = await users
      .find(filter, { projection: { password: 0 } })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();

    res.json({ users: items, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("Admin users error:", err);
    res.status(500).json({ error: "Server error fetching users" });
  }
});

router.patch("/users/:id", async (req, res) => {
  try {
    const { active, userType } = req.body;

    const set = { updatedAt: new Date() };
    if (typeof active === "boolean") set.active = active;
    if (userType !== undefined) {
      if (!VALID_USER_TYPES.includes(userType)) {
        return res.status(400).json({ error: "Invalid user type" });
      }
      if (req.params.id === req.user.id && userType !== "admin") {
        return res.status(400).json({ error: "You cannot change your own admin role" });
      }
      set.userType = userType;
    }

    if (Object.keys(set).length === 1) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    await getDb().collection("users").updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: set }
    );

    await notifyActivity({
      type: "admin_user_updated",
      user: req.user,
      label: `Updated user ${req.params.id}`,
      details: { userId: req.params.id, userType, active },
    });

    res.json({ message: "User updated" });
  } catch (err) {
    console.error("Admin update user error:", err);
    res.status(500).json({ error: "Server error updating user" });
  }
});

/* ---------------- Providers ---------------- */
router.get("/providers", async (req, res) => {
  try {
    const { q, verified } = req.query;
    const filter = {};
    if (verified === "true") filter.verificationStatus = "Verified";
    if (verified === "false") filter.verificationStatus = { $ne: "Verified" };
    if (q) {
      filter.$or = [
        { businessName: new RegExp(String(q), "i") },
        { specialty: new RegExp(String(q), "i") },
        { location: new RegExp(String(q), "i") },
      ];
    }

    const providers = await getDb().collection("providers").find(filter).sort({ createdAt: -1 }).toArray();
    res.json({ providers });
  } catch (err) {
    console.error("Admin providers error:", err);
    res.status(500).json({ error: "Server error fetching providers" });
  }
});

router.patch("/providers/:id", async (req, res) => {
  try {
    const { isAvailable, verificationStatus } = req.body;
    const set = { updatedAt: new Date() };

    if (typeof isAvailable === "boolean") set.isAvailable = isAvailable;
    if (verificationStatus !== undefined) {
      if (!["Unverified", "Pending", "Verified", "Rejected"].includes(verificationStatus)) {
        return res.status(400).json({ error: "Invalid verification status" });
      }
      set.verificationStatus = verificationStatus;
    }

    const result = await getDb().collection("providers").updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: set }
    );

    if (result.modifiedCount === 0) {
      return res.status(404).json({ error: "Provider not found" });
    }

    if (verificationStatus !== undefined) {
      await notifyActivity({
        type: "verification_reviewed",
        user: req.user,
        label: `${verificationStatus} provider verification`,
        details: { providerId: req.params.id, verificationStatus },
      });
    }

    res.json({ message: "Provider updated" });
  } catch (err) {
    console.error("Admin update provider error:", err);
    res.status(500).json({ error: "Server error updating provider" });
  }
});

/* ---------------- Bookings ---------------- */
router.get("/bookings", async (req, res) => {
  try {
    const { status, q } = req.query;
    const filter = {};
    if (status && VALID_STATUSES.includes(status)) filter.status = status;
    if (q) {
      filter.$or = [
        { bookingId: new RegExp(String(q), "i") },
        { providerName: new RegExp(String(q), "i") },
        { customerName: new RegExp(String(q), "i") },
        { service: new RegExp(String(q), "i") },
      ];
    }

    const bookings = await getDb().collection("bookings").find(filter).sort({ createdAt: -1 }).toArray();
    res.json({ bookings, total: bookings.length });
  } catch (err) {
    console.error("Admin bookings error:", err);
    res.status(500).json({ error: "Server error fetching bookings" });
  }
});

router.patch("/bookings/:bookingId/status", async (req, res) => {
  try {
    const { status } = req.body;
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` });
    }

    const db = getDb();
    const bookings = db.collection("bookings");

    let booking;
    try {
      booking = await bookings.findOne({ _id: new ObjectId(req.params.bookingId) });
    } catch {
      booking = await bookings.findOne({ bookingId: req.params.bookingId });
    }

    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const updateFields = { status, updatedAt: new Date() };
    if (status === "Completed") updateFields.completedAt = new Date();

    await bookings.updateOne({ _id: booking._id }, { $set: updateFields });

    await notifyActivity({
      type: "admin_booking_status_updated",
      user: req.user,
      label: `Admin changed Booking #${booking.bookingId} to ${status}`,
      details: { bookingId: booking.bookingId, service: booking.service, previousStatus: booking.status, status },
    });

    if (status === "Completed") {
      await db.collection("payments").updateOne(
        { bookingId: booking.bookingId },
        { $set: { status: "Paid", paidAt: new Date(), updatedAt: new Date() } }
      );
      await db.collection("providers").updateOne(
        { _id: booking.providerId },
        { $inc: { totalJobs: 1 } }
      );
    }

    if (booking.customerId) {
      await createNotification({
        userId: booking.customerId,
        type: "booking",
        title: `Booking ${booking.bookingId}`,
        message: `Your booking is now "${status}".`,
        link: "/dashboard",
      });
    }
    if (booking.providerId) {
      const providerDoc = await db.collection("providers").findOne({ _id: booking.providerId });
      if (providerDoc?.userId) {
        await createNotification({
          userId: providerDoc.userId,
          type: "booking",
          title: `Booking ${booking.bookingId}`,
          message: `Booking ${booking.bookingId} is now "${status}".`,
          link: "/dashboard",
        });
      }
    }

    res.json({ message: `Booking status updated to ${status}` });
  } catch (err) {
    console.error("Admin update booking error:", err);
    res.status(500).json({ error: "Server error updating booking" });
  }
});

/* ---------------- Payments ---------------- */
router.get("/payments", async (req, res) => {
  try {
    const db = getDb();
    const payments = await db.collection("payments").find().sort({ createdAt: -1 }).toArray();

    const totalCollected = payments.filter((p) => p.status === "Paid").reduce((s, p) => s + (Number(p.platformFee) || 0), 0);
    const totalVolume = payments.filter((p) => p.status === "Paid").reduce((s, p) => s + (Number(p.amount) || 0), 0);

    res.json({ payments, totalCollected, totalVolume, count: payments.length });
  } catch (err) {
    console.error("Admin payments error:", err);
    res.status(500).json({ error: "Server error fetching payments" });
  }
});

/* ---------------- Reviews ---------------- */
router.get("/reviews", async (req, res) => {
  try {
    const { q } = req.query;
    const filter = {};
    if (q) {
      filter.$or = [
        { customerName: new RegExp(String(q), "i") },
        { comment: new RegExp(String(q), "i") },
      ];
    }

    const reviews = await getDb().collection("reviews").find(filter).sort({ createdAt: -1 }).toArray();
    res.json({ reviews });
  } catch (err) {
    console.error("Admin reviews error:", err);
    res.status(500).json({ error: "Server error fetching reviews" });
  }
});

router.delete("/reviews/:id", async (req, res) => {
  try {
    const db = getDb();
    const reviews = db.collection("reviews");
    const review = await reviews.findOne({ _id: new ObjectId(req.params.id) });

    if (!review) {
      return res.status(404).json({ error: "Review not found" });
    }

    await reviews.deleteOne({ _id: review._id });

    const providerReviews = await reviews.find({ providerId: review.providerId }).toArray();
    if (providerReviews.length > 0) {
      const total = providerReviews.reduce((s, r) => s + r.rating, 0);
      const avg = Math.round((total / providerReviews.length) * 10) / 10;
      await db.collection("providers").updateOne(
        { _id: review.providerId },
        { $set: { rating: avg, totalReviews: providerReviews.length } }
      );
    } else {
      await db.collection("providers").updateOne(
        { _id: review.providerId },
        { $set: { rating: 0, totalReviews: 0 } }
      );
    }

    res.json({ message: "Review removed" });
  } catch (err) {
    console.error("Admin delete review error:", err);
    res.status(500).json({ error: "Server error deleting review" });
  }
});

/* ---------------- Services / categories ---------------- */
router.get("/services", async (req, res) => {
  try {
    const services = await getDb().collection("service_categories").find().sort({ order: 1, name: 1 }).toArray();
    res.json({ services });
  } catch (err) {
    console.error("Admin services error:", err);
    res.status(500).json({ error: "Server error fetching services" });
  }
});

router.post("/services", async (req, res) => {
  try {
    const { name, icon, desc } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "Service name is required" });
    }

    const result = await getDb().collection("service_categories").insertOne({
      name: String(name).trim(),
      icon: icon || "fa-tools",
      desc: desc || "",
      active: true,
      order: 99,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await notifyActivity({ type: "service_created", user: req.user, label: `Created service category ${String(name).trim()}`, details: {} });

    res.status(201).json({ message: "Service added", service: { _id: result.insertedId, name, icon: icon || "fa-tools", desc: desc || "", active: true } });
  } catch (err) {
    console.error("Admin add service error:", err);
    res.status(500).json({ error: "Server error adding service" });
  }
});

router.patch("/services/:id", async (req, res) => {
  try {
    const { name, icon, desc, active } = req.body;
    const set = { updatedAt: new Date() };
    if (name !== undefined) set.name = String(name).trim();
    if (icon !== undefined) set.icon = icon;
    if (desc !== undefined) set.desc = desc;
    if (typeof active === "boolean") set.active = active;

    await getDb().collection("service_categories").updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: set }
    );

    await notifyActivity({ type: "service_updated", user: req.user, label: `Updated service category ${req.params.id}`, details: { active } });

    res.json({ message: "Service updated" });
  } catch (err) {
    console.error("Admin update service error:", err);
    res.status(500).json({ error: "Server error updating service" });
  }
});

router.delete("/services/:id", async (req, res) => {
  try {
    await getDb().collection("service_categories").deleteOne({ _id: new ObjectId(req.params.id) });
    await notifyActivity({ type: "service_deleted", user: req.user, label: `Deleted service category ${req.params.id}`, details: {} });
    res.json({ message: "Service removed" });
  } catch (err) {
    console.error("Admin delete service error:", err);
    res.status(500).json({ error: "Server error deleting service" });
  }
});

/* ---------------- Verification requests ---------------- */
router.get("/verifications", async (req, res) => {
  try {
    const db = getDb();
    const items = await db.collection("verification_requests").find().sort({ createdAt: -1 }).toArray();

    const providerIds = items.filter((i) => i.providerId).map((i) => i.providerId);
    const providers = providerIds.length
      ? await db.collection("providers").find({ _id: { $in: providerIds } }).toArray()
      : [];
    const providerById = new Map(providers.map((p) => [p._id.toString(), p]));

    const verifications = items.map((v) => ({
      ...v,
      provider: providerById.get(v.providerId.toString()) || null,
    }));

    res.json({ verifications });
  } catch (err) {
    console.error("Admin verifications error:", err);
    res.status(500).json({ error: "Server error fetching verifications" });
  }
});

router.patch("/verifications/:id", async (req, res) => {
  try {
    const { status } = req.body;
    if (!["Approved", "Rejected"].includes(status)) {
      return res.status(400).json({ error: 'Status must be "Approved" or "Rejected"' });
    }

    const db = getDb();
    const verification = await db.collection("verification_requests").findOne({ _id: new ObjectId(req.params.id) });

    if (!verification) {
      return res.status(404).json({ error: "Verification request not found" });
    }

    const nextProviderStatus = status === "Approved" ? "Verified" : "Rejected";

    await db.collection("verification_requests").updateOne(
      { _id: verification._id },
      { $set: { status, reviewedBy: new ObjectId(req.user.id), reviewedAt: new Date(), updatedAt: new Date() } }
    );

    await db.collection("providers").updateOne(
      { _id: verification.providerId },
      { $set: { verificationStatus: nextProviderStatus, updatedAt: new Date() } }
    );

    await notifyActivity({
      type: "verification_reviewed",
      user: req.user,
      details: { providerId: verification.providerId, status },
    });

    await createNotification({
      userId: verification.userId,
      type: "verification",
      title: status === "Approved" ? "Verification approved" : "Verification rejected",
      message: status === "Approved"
        ? "Congratulations! Your provider profile is now verified."
        : "Your verification request was rejected. Please review and resubmit.",
      link: "/dashboard",
    });

    res.json({ message: `Verification ${status.toLowerCase()}` });
  } catch (err) {
    console.error("Admin verification error:", err);
    res.status(500).json({ error: "Server error updating verification" });
  }
});

/* ---------------- Reports / disputes ---------------- */
router.get("/reports", async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status === "Open" || status === "Resolved") filter.status = status;

    const reports = await getDb().collection("reports").find(filter).sort({ createdAt: -1 }).toArray();
    res.json({ reports });
  } catch (err) {
    console.error("Admin reports error:", err);
    res.status(500).json({ error: "Server error fetching reports" });
  }
});

router.patch("/reports/:id", async (req, res) => {
  try {
    const { status } = req.body;
    if (!["Open", "Resolved"].includes(status)) {
      return res.status(400).json({ error: 'Status must be "Open" or "Resolved"' });
    }

    await getDb().collection("reports").updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status, updatedAt: new Date() } }
    );

    res.json({ message: "Report updated" });
  } catch (err) {
    console.error("Admin report update error:", err);
    res.status(500).json({ error: "Server error updating report" });
  }
});

/* ---------------- Analytics ---------------- */
router.get("/analytics", async (req, res) => {
  try {
    const db = getDb();

    const [bookings, bookingsByStatus, users, providers, payments] = await Promise.all([
      db.collection("bookings").find().toArray(),
      db.collection("bookings").aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]).toArray(),
      db.collection("users").aggregate([{ $group: { _id: "$userType", count: { $sum: 1 } } }]).toArray(),
      db.collection("providers").aggregate([{ $group: { _id: "$specialty", count: { $sum: 1 } } }]).toArray(),
      db.collection("payments").find({ status: "Paid" }).toArray(),
    ]);

    const revenueTotal = payments.reduce((s, p) => s + (Number(p.platformFee) || 0), 0);
    const volumeTotal = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);

    res.json({
      bookingsByStatus: Object.fromEntries(bookingsByStatus.map((b) => [b._id, b.count])),
      usersByRole: Object.fromEntries(users.map((u) => [u._id, u.count])),
      providersBySpecialty: providers.map((p) => ({ specialty: p._id, count: p.count })),
      bookingsTrend: [
        { month: "This month", count: bookings.filter((b) => {
          const d = new Date(b.createdAt);
          const now = new Date();
          return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        }).length },
        { month: "Last month", count: bookings.filter((b) => {
          const d = new Date(b.createdAt);
          const now = new Date();
          const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          return d >= lm && d < new Date(now.getFullYear(), now.getMonth(), 1);
        }).length },
      ],
      revenueTotal,
      volumeTotal,
    });
  } catch (err) {
    console.error("Admin analytics error:", err);
    res.status(500).json({ error: "Server error fetching analytics" });
  }
});

/* ---------------- Recent activity ---------------- */
router.get("/activity", async (req, res) => {
  try {
    const { role, actionType, q, from, to } = req.query;
    const filter = {};
    if (["client", "provider", "admin"].includes(role)) filter.$or = [{ role }, { userType: role }];
    if (actionType && actionType !== "all") {
      const actionRegex = actionType === "bookings" ? /^booking_/ : actionType === "auth" ? /^user_(registered|login|logout)$/ : actionType === "verifications" ? /verification/ : actionType === "reviews" ? /review/ : null;
      if (actionRegex) filter.action = actionRegex;
    }
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(`${to}T23:59:59.999Z`);
    }
    if (q) {
      const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$and = [{ $or: [{ userName: rx }, { name: rx }, { userEmail: rx }, { email: rx }, { "details.bookingId": rx }, { label: rx }] }];
    }
    const items = await getDb().collection("activity_logs").find(filter).sort({ createdAt: -1 }).limit(200).toArray();
    res.json({ activity: items });
  } catch (err) {
    console.error("Admin activity error:", err);
    res.status(500).json({ error: "Server error fetching activity" });
  }
});

module.exports = router;