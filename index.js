const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();

const dbConnection = require("./db");

const authRoutes = require("./routes/auth");
const bookingRoutes = require("./routes/bookings");
const providerRoutes = require("./routes/providers");
const reviewRoutes = require("./routes/reviews");
const settingsRoutes = require("./routes/settings");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

app.get("/", (req, res) => {
  res.json({ message: "TrustConnect API is running" });
});

app.use("/api/auth", authRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/providers", providerRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/settings", settingsRoutes);

async function startServer() {
  try {
    const db = await dbConnection.connectDB();

    await db.collection("users").createIndex({ email: 1 }, { unique: true });
    await db.collection("bookings").createIndex({ customerId: 1 });
    await db.collection("bookings").createIndex({ bookingId: 1 }, { unique: true });
    await db.collection("providers").createIndex({ userId: 1 });
    await db.collection("reviews").createIndex({ bookingId: 1 });
    await db.collection("reviews").createIndex({ providerId: 1 });

    const settings = db.collection("settings");
    const existing = await settings.findOne({ key: "platform" });
    if (!existing) {
      await settings.insertOne({ key: "platform", platformFeePercentage: 10 });
    }

    console.log("Database indexes created");
  } catch (err) {
    console.error("MongoDB setup error:", err.message);
    console.error("Server is running, but database features are unavailable.");
  }

  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

startServer();
