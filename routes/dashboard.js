const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { authMiddleware } = require("../middleware/auth");

const router = express.Router();

function localDateString(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const ACTIVITY_LABELS = {
  register: "Account created",
  login: "Signed in",
  booking: "Booking submitted",
  booking_status: "Booking status updated",
  verification_submitted: "Verification submitted",
};

router.get("/", authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const { userType, id: userId } = req.user;

    const notifications = await db
      .collection("notifications")
      .find({ userId: new ObjectId(userId) })
      .sort({ createdAt: -1 })
      .limit(8)
      .toArray();

    if (userType === "provider") {
      const providers = db.collection("providers");
      const bookings = db.collection("bookings");
      const reviews = db.collection("reviews");

      let provider = null;
      if (req.user.providerId && ObjectId.isValid(req.user.providerId)) {
        provider = await providers.findOne({ _id: new ObjectId(req.user.providerId) });
      }
      if (!provider) {
        provider = await providers.findOne({ userId: new ObjectId(userId) });
      }

      if (!provider) {
        return res.json({
          role: "provider",
          provider: null,
          notifications,
          needsProfile: true,
          stats: { todayJobs: 0, pendingRequests: 0, currentJobs: 0, completed: 0, rating: 0, totalReviews: 0 },
          upcomingJobs: [],
          recentReviews: [],
          earnings: { totalEarnings: 0, platformFees: 0, jobCount: 0 },
        });
      }

      const providerId = provider._id;
      const today = localDateString();

      const [allBookings, recentReviews, reviewCount] = await Promise.all([
        bookings.find({ providerId }).toArray(),
        reviews.find({ providerId }).sort({ createdAt: -1 }).limit(4).toArray(),
        reviews.countDocuments({ providerId }),
      ]);

      const todayJobs = allBookings.filter(
        (b) => ["Accepted", "Confirmed", "In Progress"].includes(b.status) && b.date === today
      );
      const pendingRequests = allBookings.filter((b) => b.status === "Pending").length;
      const currentJobs = allBookings
        .filter((b) => ["Accepted", "Confirmed", "In Progress"].includes(b.status))
        .sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
      const completedBookings = allBookings.filter((b) => b.status === "Completed");

      const upcomingJobs = currentJobs.slice(0, 5);

      const totalEarnings = completedBookings.reduce((sum, b) => sum + (Number(b.providerAmount) || 0), 0);
      const platformFees = completedBookings.reduce((sum, b) => sum + (Number(b.platformFee) || 0), 0);

      return res.json({
        role: "provider",
        provider,
        notifications,
        needsProfile: false,
        stats: {
          todayJobs: todayJobs.length,
          pendingRequests,
          currentJobs: currentJobs.length,
          completed: completedBookings.length,
          totalClients: new Set(
            allBookings.map((b) => (b.customerId ? String(b.customerId) : b.customerName || ""))
          ).size,
          totalBookings: allBookings.length,
          accepted: allBookings.filter((b) => b.status === "Accepted").length,
          inProgress: allBookings.filter((b) => b.status === "In Progress").length,
          rejected: allBookings.filter((b) => b.status === "Rejected").length,
          cancelled: allBookings.filter((b) => ["Cancelled", "Rejected"].includes(b.status)).length,
          rating: provider.rating || 0,
          totalReviews: reviewCount,
          verificationStatus: provider.verificationStatus || "Unverified",
        },
        upcomingJobs,
        recentReviews: recentReviews,
        earnings: { totalEarnings, platformFees, jobCount: completedBookings.length },
      });
    }

    if (userType === "admin") {
      const [users, providers, bookings, verifications, reports, payments] = await Promise.all([
        db.collection("users").countDocuments(),
        db.collection("providers").countDocuments(),
        db.collection("bookings").countDocuments(),
        db.collection("verification_requests").countDocuments({ status: "Pending" }),
        db.collection("reports").countDocuments({ status: "Open" }),
        db.collection("payments").find({ status: "Paid" }).toArray(),
      ]);

      const revenue = payments.reduce((sum, p) => sum + (Number(p.platformFee) || 0), 0);

      const recentActivity = await db
        .collection("activity_logs")
        .find()
        .sort({ createdAt: -1 })
        .limit(10)
        .toArray();

      const recentBookings = await db
        .collection("bookings")
        .find()
        .sort({ createdAt: -1 })
        .limit(8)
        .toArray();

      return res.json({
        role: "admin",
        notifications,
        stats: { users, providers, bookings: bookings || 0, revenue, pendingVerifications: verifications, openReports: reports },
        recentActivity,
        recentBookings,
      });
    }

    const bookings = db.collection("bookings");
    const providersCol = db.collection("providers");
    const usersCol = db.collection("users");

    const myBookings = await bookings.find({ customerId: new ObjectId(userId) }).toArray();

    const active = myBookings.filter((b) => ["Pending", "Accepted", "Confirmed", "In Progress"].includes(b.status)).length;
    const completed = myBookings.filter((b) => b.status === "Completed").length;
    const cancelled = myBookings.filter((b) => ["Cancelled", "Rejected"].includes(b.status)).length;

    const me = await usersCol.findOne({ _id: new ObjectId(userId) }, { projection: { password: 0 } });
    const saved = (me?.savedProviderIds || []).length;

    const upcomingBooking = myBookings
      .filter((b) => ["Pending", "Accepted", "Confirmed", "In Progress"].includes(b.status))
      .sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`))[0] || null;

    const recommendedProviders = await providersCol
      .find({ isAvailable: true })
      .sort({ rating: -1 })
      .limit(4)
      .toArray();

    const recentActivityRows = await db
      .collection("activity_logs")
      .find({ $or: [{ userId: new ObjectId(userId) }, { userId: userId }] })
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();

    const recentActivity = recentActivityRows.map((a) => ({
      _id: a._id,
      label: ACTIVITY_LABELS[a.type] || a.type,
      details: a.details,
      createdAt: a.createdAt,
    }));

    return res.json({
      role: "client",
      notifications,
      stats: { active, completed, cancelled, saved },
      upcomingBooking,
      recommendedProviders,
      recentActivity,
    });
  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).json({ error: "Server error loading dashboard" });
  }
});

module.exports = router;