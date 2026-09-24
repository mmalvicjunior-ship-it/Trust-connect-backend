const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { authMiddleware } = require("../middleware/auth");
const { notifyActivity } = require("../notifications");

const router = express.Router();

router.post("/", authMiddleware, async (req, res) => {
  try {
    const { bookingId, providerId, rating, comment } = req.body;

    if (!bookingId || !providerId || !rating) {
      return res.status(400).json({ error: "Booking ID, provider ID and rating are required" });
    }

    if (rating < 1 || rating > 5 || !Number.isInteger(rating)) {
      return res.status(400).json({ error: "Rating must be an integer between 1 and 5" });
    }

    const db = getDb();
    const reviews = db.collection("reviews");
    const bookings = db.collection("bookings");
    const providers = db.collection("providers");

    const booking = await bookings.findOne({ bookingId });
    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    if (booking.customerId.toString() !== req.user.id) {
      return res.status(403).json({ error: "You can only review your own bookings" });
    }

    if (booking.status !== "Completed") {
      return res.status(400).json({ error: "You can only review completed bookings" });
    }

    const existingReview = await reviews.findOne({
      bookingId: bookingId,
      customerId: new ObjectId(req.user.id),
    });
    if (existingReview) {
      return res.status(409).json({ error: "You have already reviewed this booking" });
    }

    const review = {
      bookingId,
      customerId: new ObjectId(req.user.id),
      customerName: req.user.fullName || req.user.email,
      providerId: new ObjectId(providerId),
      rating,
      comment: comment || "",
      createdAt: new Date(),
    };

    const result = await reviews.insertOne(review);

    const providerReviews = await reviews.find({ providerId: new ObjectId(providerId) }).toArray();
    const totalRating = providerReviews.reduce((sum, r) => sum + r.rating, 0);
    const avgRating = Math.round((totalRating / providerReviews.length) * 10) / 10;

    await providers.updateOne(
      { _id: new ObjectId(providerId) },
      { $set: { rating: avgRating, totalReviews: providerReviews.length } }
    );

    await notifyActivity({
      type: "review_submitted",
      user: req.user,
      label: `Submitted ${rating}-star review for Booking #${bookingId}`,
      details: { bookingId, providerId, rating },
    });

    res.status(201).json({
      message: "Review submitted successfully",
      review: { ...review, _id: result.insertedId },
    });
  } catch (err) {
    console.error("Create review error:", err);
    res.status(500).json({ error: "Server error creating review" });
  }
});

router.get("/provider/:providerId", async (req, res) => {
  try {
    const db = getDb();
    const reviews = db.collection("reviews");

    const providerReviews = await reviews
      .find({ providerId: new ObjectId(req.params.providerId) })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ reviews: providerReviews });
  } catch (err) {
    console.error("Get reviews error:", err);
    res.status(500).json({ error: "Server error fetching reviews" });
  }
});

module.exports = router;
