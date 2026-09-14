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

module.exports = { notifyActivity };
