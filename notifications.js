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

async function notifyActivity({ type, user, details = {} }) {
  const activity = {
    type,
    userId: user?._id || user?.id || null,
    email: user?.email || "",
    name: user?.fullName || [user?.firstName, user?.lastName].filter(Boolean).join(" ") || "",
    userType: user?.userType || "",
    details,
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
