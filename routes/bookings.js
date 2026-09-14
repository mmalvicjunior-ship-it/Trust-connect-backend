const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { authMiddleware } = require("../middleware/auth");
const { notifyActivity } = require("../notifications");

const router = express.Router();

const VALID_STATUSES = ["Pending", "Accepted", "Completed", "Rejected", "Cancelled"];

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

    await notifyActivity({
      type: "booking",
      user: req.user,
      details: {
        bookingId: booking.bookingId,
        service: booking.service,
        providerName: booking.providerName,
        amount: booking.amount,
        location: booking.location,
      },
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

router.get("/:bookingId", authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const bookings = db.collection("bookings");

    const booking = await bookings.findOne({
      bookingId: req.params.bookingId,
      customerId: new ObjectId(req.user.id),
    });

    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const isCustomer = booking.customerId.toString() === req.user.id;
    const isProvider = booking.providerId && req.user.providerId && booking.providerId.toString() === req.user.providerId.toString();
    const customerAllowed = isCustomer && status === "Cancelled";
    const providerAllowed = isProvider && ["Accepted", "Rejected", "Completed"].includes(status);

    if (!customerAllowed && !providerAllowed) {
      return res.status(403).json({ error: "You are not allowed to change this booking" });
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

    const booking = await bookings.findOne({ bookingId: req.params.bookingId });
    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const validTransitions = {
      Pending: ["Accepted", "Rejected", "Cancelled"],
      Accepted: ["Completed", "Cancelled"],
      Completed: [],
      Rejected: [],
      Cancelled: [],
    };

    const allowed = validTransitions[booking.status] || [];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        error: `Cannot change status from "${booking.status}" to "${status}"`,
      });
    }

    await bookings.updateOne(
      { bookingId: req.params.bookingId },
      { $set: { status, updatedAt: new Date() } }
    );

    res.json({ message: `Booking status updated to ${status}`, status });
  } catch (err) {
    console.error("Update booking status error:", err);
    res.status(500).json({ error: "Server error updating booking status" });
  }
});

module.exports = router;
