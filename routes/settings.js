const express = require("express");
const { getDb } = require("../db");

const router = express.Router();

const DEFAULT_SETTINGS = {
  platformFeePercentage: 10,
};

router.get("/platform-fee", async (req, res) => {
  try {
    const db = getDb();
    const settings = db.collection("settings");

    const config = await settings.findOne({ key: "platform" });

    res.json({
      platformFeePercentage: config
        ? config.platformFeePercentage
        : DEFAULT_SETTINGS.platformFeePercentage,
    });
  } catch (err) {
    console.error("Get settings error:", err);
    res.json({ platformFeePercentage: DEFAULT_SETTINGS.platformFeePercentage });
  }
});

module.exports = router;
