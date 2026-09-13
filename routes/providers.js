const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { authMiddleware } = require("../middleware/auth");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const db = getDb();
    const providers = db.collection("providers");

    const allProviders = await providers.find({ isAvailable: true }).toArray();
    res.json({ providers: allProviders });
  } catch (err) {
    console.error("Get providers error:", err);
    res.status(500).json({ error: "Server error fetching providers" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const db = getDb();
    const providers = db.collection("providers");

    let provider;
    try {
      provider = await providers.findOne({ _id: new ObjectId(req.params.id) });
    } catch {
      provider = await providers.findOne({ slug: req.params.id });
    }

    if (!provider) {
      return res.status(404).json({ error: "Provider not found" });
    }

    res.json({ provider });
  } catch (err) {
    console.error("Get provider error:", err);
    res.status(500).json({ error: "Server error fetching provider" });
  }
});

router.post("/", authMiddleware, async (req, res) => {
  try {
    if (req.user.userType !== "provider") {
      return res.status(403).json({ error: "Only provider accounts can create provider profiles" });
    }

    const { businessName, specialty, location, bio, hourlyRate } = req.body;

    if (!businessName || !specialty) {
      return res.status(400).json({ error: "Business name and specialty are required" });
    }

    const db = getDb();
    const providers = db.collection("providers");

    const existing = await providers.findOne({ userId: new ObjectId(req.user.id) });
    if (existing) {
      return res.status(409).json({ error: "You already have a provider profile" });
    }

    const provider = {
      userId: new ObjectId(req.user.id),
      businessName,
      specialty,
      location: location || "",
      bio: bio || "",
      hourlyRate: hourlyRate || 0,
      isAvailable: true,
      rating: 0,
      totalReviews: 0,
      totalJobs: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await providers.insertOne(provider);

    await db.collection("users").updateOne(
      { _id: new ObjectId(req.user.id) },
      { $set: { providerId: result.insertedId, updatedAt: new Date() } }
    );

    res.status(201).json({
      message: "Provider profile created",
      provider: { ...provider, _id: result.insertedId },
    });
  } catch (err) {
    console.error("Create provider error:", err);
    res.status(500).json({ error: "Server error creating provider profile" });
  }
});

module.exports = router;
