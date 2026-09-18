const dotenv = require("dotenv");
const bcrypt = require("bcryptjs");
const { connectDB } = require("../db");

async function seedAdmin() {
  dotenv.config();

  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";

  if (!email || !password) {
    console.error("Please set ADMIN_EMAIL and ADMIN_PASSWORD in backend/.env, then run: npm run seed:admin");
    process.exit(1);
  }

  const db = await connectDB();
  const users = db.collection("users");

  const existing = await users.findOne({ email });

  if (existing) {
    if (existing.userType === "admin") {
      console.log("Admin account already exists for", email);
    } else {
      await users.updateOne({ _id: existing._id }, { $set: { userType: "admin", updatedAt: new Date() } });
      console.log("Existing account promoted to admin:", email);
    }
  } else {
    const salt = await bcrypt.genSalt(10);
    const hashed = await bcrypt.hash(password, salt);

    await users.insertOne({
      firstName: "Admin",
      lastName: "User",
      fullName: "Admin User",
      email,
      phone: "",
      password: hashed,
      userType: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log("Admin account created:", email);
  }

  console.log("Admin accounts:");
  const admins = await users.find({ userType: "admin" }, { projection: { password: 0 } }).toArray();
  admins.forEach((a) => console.log(`- ${a.email}`));

  process.exit(0);
}

seedAdmin().catch((err) => {
  console.error(err.message);
  process.exit(1);
});