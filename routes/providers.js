const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { authMiddleware, requireRole } = require("../middleware/auth");
const { notifyActivity, createNotification } = require("../notifications");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const db = getDb();
    const providers = db.collection("providers");

    const allProviders = await providers.find({ isAvailable: true }, { projection: { userId: 0 } }).sort({ rating: -1 }).toArray();
    res.json({ providers: allProviders });
  } catch (err) {
    console.error("Get providers error:", err);
    res.status(500).json({ error: "Server error fetching providers" });
  }
});

router.get("/me", authMiddleware, requireRole("provider"), async (req, res) => {
  try {
    const db = getDb();
    const providers = db.collection("providers");

    let provider = null;
    if (req.user.providerId && ObjectId.isValid(req.user.providerId)) {
      provider = await providers.findOne({ _id: new ObjectId(req.user.providerId) });
    }
    if (!provider) {
      provider = await providers.findOne({ userId: new ObjectId(req.user.id) });
    }

    if (!provider) {
      return res.status(404).json({ error: "You do not have a provider profile yet" });
    }

    res.json({ provider });
  } catch (err) {
    console.error("Get my provider error:", err);
    res.status(500).json({ error: "Server error fetching provider profile" });
  }
});

router.patch("/me", authMiddleware, requireRole("provider"), async (req, res) => {
  try {
    const db = getDb();
    const providers = db.collection("providers");

    let provider = null;
    if (req.user.providerId && ObjectId.isValid(req.user.providerId)) {
      provider = await providers.findOne({ _id: new ObjectId(req.user.providerId) });
    }
    if (!provider) {
      provider = await providers.findOne({ userId: new ObjectId(req.user.id) });
    }

    if (!provider) {
      return res.status(404).json({ error: "You do not have a provider profile yet" });
    }

    const { businessName, specialty, location, bio, hourlyRate, isAvailable, services } = req.body;
    const update = { updatedAt: new Date() };

    if (businessName !== undefined) update.businessName = businessName;
    if (specialty !== undefined) update.specialty = specialty;
    if (location !== undefined) update.location = location;
    if (bio !== undefined) update.bio = bio;
    if (hourlyRate !== undefined) update.hourlyRate = Number(hourlyRate) || 0;
    if (isAvailable !== undefined) update.isAvailable = Boolean(isAvailable);
    if (Array.isArray(services)) update.services = services;

    await providers.updateOne({ _id: provider._id }, { $set: update });

    if (Object.keys(update).some((key) => key !== "updatedAt")) {
      await notifyActivity({
        type: "profile_updated",
        action: update.isAvailable !== undefined && Object.keys(update).length === 2 ? "availability_updated" : "profile_updated",
        label: update.isAvailable !== undefined && Object.keys(update).length === 2
          ? `Provider availability set ${update.isAvailable ? "Online" : "Offline"}`
          : "Updated provider profile",
        user: req.user,
        details: {
          businessName: update.businessName,
          specialty: update.specialty,
          active: update.isAvailable,
        },
      });
    }

    const updated = await providers.findOne({ _id: provider._id });
    res.json({ message: "Provider profile updated", provider: updated });
  } catch (err) {
    console.error("Update provider error:", err);
    res.status(500).json({ error: "Server error updating provider profile" });
  }
});

router.get("/saved", authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const users = db.collection("users");
    const providers = db.collection("providers");

    const user = await users.findOne({ _id: new ObjectId(req.user.id) });
    const ids = (user?.savedProviderIds || []).map((id) => (ObjectId.isValid(id) ? new ObjectId(id) : id));

    const saved = ids.length
      ? await providers.find({ _id: { $in: ids } }, { projection: { userId: 0 } }).toArray()
      : [];

    res.json({ savedProviders: saved });
  } catch (err) {
    console.error("Get saved providers error:", err);
    res.status(500).json({ error: "Server error fetching saved providers" });
  }
});

router.post("/saved/:providerId", authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const users = db.collection("users");
    const providerId = req.params.providerId;

    const user = await users.findOne({ _id: new ObjectId(req.user.id) });
    const current = user?.savedProviderIds || [];
    const exists = current.some((id) => String(id) === providerId);

    let saved;
    if (exists) {
      await users.updateOne(
        { _id: new ObjectId(req.user.id) },
        { $pull: { savedProviderIds: { $in: [new ObjectId(providerId)] } } }
      );
      saved = false;
    } else {
      await users.updateOne(
        { _id: new ObjectId(req.user.id) },
        { $addToSet: { savedProviderIds: new ObjectId(providerId) } }
      );
      saved = true;
    }

    res.json({ saved, providerId });
  } catch (err) {
    console.error("Toggle saved provider error:", err);
    res.status(500).json({ error: "Server error updating saved providers" });
  }
});

router.get("/earnings", authMiddleware, requireRole("provider"), async (req, res) => {
  try {
    const db = getDb();
    const bookings = db.collection("bookings");

    let providerId = req.user.providerId && ObjectId.isValid(req.user.providerId)
      ? new ObjectId(req.user.providerId)
      : null;
    if (!providerId && ObjectId.isValid(req.user.id)) {
      const provider = await db.collection("providers").findOne({ userId: new ObjectId(req.user.id) });
      providerId = provider?._id || null;
    }

    if (!providerId) {
      return res.json({ totalEarnings: 0, platformFees: 0, jobCount: 0, weekly: [], recent: [] });
    }

    const completed = await bookings.find({ providerId, status: "Completed" }).toArray();

    const totalEarnings = completed.reduce((sum, b) => sum + (Number(b.providerAmount) || 0), 0);
    const platformFees = completed.reduce((sum, b) => sum + (Number(b.platformFee) || 0), 0);

    const recent = completed
      .sort((a, b) => new Date(b.completedAt || b.updatedAt) - new Date(a.completedAt || a.updatedAt))
      .slice(0, 10);

    res.json({ totalEarnings, platformFees, jobCount: completed.length, recent });
  } catch (err) {
    console.error("Get earnings error:", err);
    res.status(500).json({ error: "Server error fetching earnings" });
  }
});

router.post("/verification", authMiddleware, requireRole("provider"), async (req, res) => {
  try {
    const db = getDb();
    const providers = db.collection("providers");
    const verifications = db.collection("verification_requests");

    let provider = null;
    if (req.user.providerId && ObjectId.isValid(req.user.providerId)) {
      provider = await providers.findOne({ _id: new ObjectId(req.user.providerId) });
    }
    if (!provider) {
      provider = await providers.findOne({ userId: new ObjectId(req.user.id) });
    }

    if (!provider) {
      return res.status(404).json({ error: "Create your provider profile before applying for verification" });
    }

    const existing = await verifications
      .find({ providerId: provider._id, status: "Pending" })
      .sort({ createdAt: -1 })
      .limit(1)
      .next();

    if (existing) {
      return res.status(400).json({ error: "You already have a pending verification request" });
    }

    const { idNumber, profession, documents, phoneConfirmed } = req.body;

    await verifications.insertOne({
      providerId: provider._id,
      userId: new ObjectId(req.user.id),
      businessName: provider.businessName,
      specialty: provider.specialty || profession || "",
      idNumber: idNumber || "",
      documents: Array.isArray(documents) ? documents : [],
      phoneConfirmed: Boolean(phoneConfirmed),
      status: "Pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await providers.updateOne(
      { _id: provider._id },
      { $set: { verificationStatus: "Pending", updatedAt: new Date() } }
    );

    await notifyActivity({
      type: "verification_submitted",
      user: req.user,
      details: { providerId: provider._id, businessName: provider.businessName },
    });

    res.status(201).json({ message: "Verification request submitted for review" });
  } catch (err) {
    console.error("Verification request error:", err);
    res.status(500).json({ error: "Server error submitting verification request" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const db = getDb();
    const providers = db.collection("providers");

    let provider;
    try {
      provider = await providers.findOne({ _id: new ObjectId(req.params.id) }, { projection: { userId: 0 } });
    } catch {
      provider = await providers.findOne({ slug: req.params.id }, { projection: { userId: 0 } });
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

    const { businessName, specialty, location, bio, hourlyRate, services } = req.body;

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
      services: Array.isArray(services) ? services : [],
      isAvailable: true,
      verificationStatus: "Unverified",
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

    await notifyActivity({
      type: "profile_created",
      action: "profile_created",
      label: `Created provider profile for ${businessName}`,
      user: { ...req.user, providerId: result.insertedId },
      details: { businessName, specialty, providerId: result.insertedId },
    });

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