const nodemailer = require("nodemailer");
const { getDb } = require("./db");

function getTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    return null;
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

const ACTION_LABELS = {
  register: "user_registered",
  login: "user_login",
  booking: "booking_created",
  booking_status_updated: "booking_status_updated",
  verification_submitted: "verification_submitted",
  verification_reviewed: "verification_reviewed",
  review_submitted: "review_submitted",
  profile_updated: "profile_updated",
  availability_updated: "availability_updated",
  admin_user_updated: "user_status_updated",
  admin_booking_status_updated: "booking_status_override",
  service_created: "service_created",
  service_updated: "service_updated",
  service_deleted: "service_deleted",
};

function sanitizeDetails(details) {
  const allowed = ["bookingId", "service", "status", "previousStatus", "providerId", "businessName", "specialty", "rating", "verificationStatus", "active", "userId", "userType", "method"];
  return Object.fromEntries(Object.entries(details || {}).filter(([key, value]) => allowed.includes(key) && value !== undefined && value !== null));
}

async function notifyActivity({ type, action, user, label, details = {} }) {
  const normalizedAction = action || ACTION_LABELS[type] || type;
  const userId = user?._id || user?.id || null;
  const userName = user?.fullName || [user?.firstName, user?.lastName].filter(Boolean).join(" ") || "";
  const userEmail = user?.email || "";
  const role = user?.userType || "";
  const sanitizedDetails = sanitizeDetails(details);
  const activity = {
    type,
    action: normalizedAction,
    label: label || normalizedAction.replaceAll("_", " "),
    userId,
    userName,
    userEmail,
    role,
    email: userEmail,
    name: userName,
    userType: role,
    details: sanitizedDetails,
    createdAt: new Date(),
  };

  try {
    await getDb().collection("activity_logs").insertOne(activity);
  } catch (err) {
    console.error("Activity log error:", err.message);
  }

  const transporter = getTransporter();
  const notificationEmail = process.env.NOTIFICATION_EMAIL;
  if (!transporter || !notificationEmail) {
    return;
  }

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: notificationEmail,
      subject: `Trust Connect: ${type}`,
      text: JSON.stringify(activity, null, 2),
    });
  } catch (err) {
    console.error("Notification email error:", err.message);
  }
}

async function createNotification({ userId, type, title, message, link }) {
  try {
    if (!userId) return null;

    await getDb().collection("notifications").insertOne({
      userId: userId._id ? userId._id : userId,
      type: type || "general",
      title: title || "Trust Connect update",
      message: message || "",
      link: link || null,
      read: false,
      createdAt: new Date(),
    });
  } catch (err) {
    console.error("Create notification error:", err.message);
  }
}

module.exports = { notifyActivity, createNotification };
