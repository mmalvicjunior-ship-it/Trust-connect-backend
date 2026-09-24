const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { authMiddleware, requireRole } = require("../middleware/auth");
const { notifyActivity, createNotification } = require("../notifications");

const router = express.Router();

const VALID_STATUSES = ["Pending", "Accepted", "In Progress", "Completed", "Cancelled"];

const VALID_TRANSITIONS = {
  Pending: ["Accepted", "Cancelled"],
  Accepted: ["In Progress", "Cancelled"],
  "In Progress": ["Completed", "Cancelled"],
  Completed: [],
  Cancelled: [],
};

const PROVIDER_STATUSES = ["Accepted", "In Progress", "Completed"];

function generateBookingId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "TC-";
  for (let i = 0; i < 8; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

async function getPlatformFeePercentage() {
  const db = getDb();
  const settings = db.collection("settings");
  const config = await settings.findOne({ key: "platform" });
  return config ? config.platformFeePercentage : 10;
}

function isProviderForBooking(booking, req) {
  return booking.providerId && req.user.providerId && booking.providerId.toString() === String(req.user.providerId);
}

router.post("/", authMiddleware, async (req, res) => {
  try {
    const {
      providerId,
      providerName,
      service,
      date,
      time,
      location,
      description,
      amount,
    } = req.body;

    if (!service || !date || !time || !location || !description || amount === undefined) {
      return res.status(400).json({ error: "Service, date, time, location, description and amount are required" });
    }

    if (isNaN(amount) || Number(amount) <= 0) {
      return res.status(400).json({ error: "Invalid booking amount" });
    }

    const db = getDb();
    const bookings = db.collection("bookings");
    const feePercentage = await getPlatformFeePercentage();

    let bookingProviderId = null;
    if (providerId) {
      if (ObjectId.isValid(providerId)) {
        bookingProviderId = new ObjectId(providerId);
      }
    }

    const bookingAmount = Number(amount);
    const platformFee = Math.round(bookingAmount * (feePercentage / 100) * 100) / 100;
    const providerAmount = Math.round((bookingAmount - platformFee) * 100) / 100;

    const booking = {
      bookingId: generateBookingId(),
      customerId: new ObjectId(req.user.id),
      customerName: req.user.fullName || req.user.email,
      providerId: bookingProviderId,
      providerName: providerName || "",
      service,
      date,
      time,
      location,
      description,
      amount: bookingAmount,
      platformFee,
      providerAmount,
      feePercentage,
      status: "Pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await bookings.insertOne(booking);

    await db.collection("payments").insertOne({
      bookingId: booking.bookingId,
      paymentId: "PAY-" + generateBookingId().slice(3),
      customerId: new ObjectId(req.user.id),
      providerId: bookingProviderId,
      amount: bookingAmount,
      platformFee,
      providerAmount,
      status: "Pending",
      method: "Card",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await notifyActivity({
      type: "booking",
      action: "booking_created",
      label: `Created Booking #${booking.bookingId}`,
      user: req.user,
      details: {
        bookingId: booking.bookingId,
        service: booking.service,
        providerName: booking.providerName,
        customerName: booking.customerName,
        amount: booking.amount,
        location: booking.location,
      },
    });

    if (bookingProviderId) {
      const providerDoc = await db.collection("providers").findOne({ _id: bookingProviderId });
      if (providerDoc) {
        await createNotification({
          userId: providerDoc.userId || null,
          type: "booking_request",
          title: "New job request",
          message: `${req.user.fullName || "A client"} booked ${booking.service} for ${booking.date} at ${booking.time}.`,
          link: "/dashboard",
        });
      }
    }

    await createNotification({
      userId: req.user.id,
      type: "booking",
      title: `Booking ${booking.bookingId} submitted`,
      message: `Your ${booking.service} booking is pending. We'll notify you when a provider responds.`,
      link: "/dashboard",
    });

    res.status(201).json({
      message: "Booking created successfully",
      booking: {
        ...booking,
        _id: result.insertedId,
      },
    });
  } catch (err) {
    console.error("Create booking error:", err);
    res.status(500).json({ error: "Server error creating booking" });
  }
});

router.get("/", authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const bookings = db.collection("bookings");

    const userBookings = await bookings
      .find({ customerId: new ObjectId(req.user.id) })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ bookings: userBookings });
  } catch (err) {
    console.error("Get bookings error:", err);
    res.status(500).json({ error: "Server error fetching bookings" });
  }
});

router.get("/provider", authMiddleware, requireRole("provider"), async (req, res) => {
  try {
    const db = getDb();
    const bookings = db.collection("bookings");

    if (!req.user.providerId) {
      return res.status(404).json({ error: "Create a provider profile first" });
    }

    const providerQuery = { providerId: new ObjectId(req.user.providerId) };
    const [requests, current, completed] = await Promise.all([
      bookings.find({ ...providerQuery, status: "Pending" }).sort({ createdAt: -1 }).toArray(),
      bookings.find({ ...providerQuery, status: { $in: ["Accepted", "In Progress"] } }).sort({ date: 1, time: 1 }).toArray(),
      bookings.find({ ...providerQuery, status: "Completed" }).sort({ completedAt: -1 }).toArray(),
    ]);

    res.json({ requests, current, completed });
  } catch (err) {
    console.error("Get provider bookings error:", err);
    res.status(500).json({ error: "Server error fetching provider bookings" });
  }
});

router.get("/:bookingId", authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const bookings = db.collection("bookings");
    const { ObjectId } = require("mongodb");

    let booking;
    try {
      booking = await bookings.findOne({ _id: new ObjectId(req.params.bookingId) });
    } catch {
      booking = await bookings.findOne({ bookingId: req.params.bookingId });
    }

    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const isCustomer = booking.customerId && booking.customerId.toString() === req.user.id;
    const isAdmin = req.user.userType === "admin";

    if (!isCustomer && !isProviderForBooking(booking, req) && !isAdmin) {
      return res.status(403).json({ error: "You are not allowed to view this booking" });
    }

    res.json({ booking });
  } catch (err) {
    console.error("Get booking error:", err);
    res.status(500).json({ error: "Server error fetching booking" });
  }
});

router.patch("/:bookingId/status", authMiddleware, async (req, res) => {
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

    const isCustomer = booking.customerId && booking.customerId.toString() === req.user.id;
    const isAdmin = req.user.userType === "admin";
    const isProvider = isProviderForBooking(booking, req);

    if (!isCustomer && !isProvider && !isAdmin) {
      return res.status(403).json({ error: "You are not allowed to change this booking" });
    }

    if (PROVIDER_STATUSES.includes(status) && !isProvider && !isAdmin) {
      return res.status(403).json({ error: "Only the assigned provider can update this booking" });
    }

    if (status === "Cancelled" && !isCustomer && !isProvider && !isAdmin) {
      return res.status(403).json({ error: "You are not allowed to cancel this booking" });
    }

    const allowed = VALID_TRANSITIONS[booking.status] || [];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        error: `Cannot change status from "${booking.status}" to "${status}"`,
      });
    }

    const updateFields = { status, updatedAt: new Date() };
    if (status === "Completed") {
      updateFields.completedAt = new Date();
    }

    await bookings.updateOne({ _id: booking._id }, { $set: updateFields });

    await notifyActivity({
      type: "booking_status_updated",
      action: `booking_${status.toLowerCase().replaceAll(" ", "_")}`,
      label: `Booking #${booking.bookingId} marked ${status}`,
      user: req.user,
      details: { bookingId: booking.bookingId, service: booking.service, previousStatus: booking.status, status },
    });

    res.json({ message: `Booking status updated to ${status}`, status });
  } catch (err) {
    console.error("Update booking status error:", err);
    res.status(500).json({ error: "Server error updating booking status" });
  }
});

module.exports = router;