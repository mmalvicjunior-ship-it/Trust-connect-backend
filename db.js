const { MongoClient } = require("mongodb");

let client;
let db;

async function connectDB() {
  const mongoUri = process.env.MONGO_URI;

  if (!mongoUri) {
    throw new Error("MONGO_URI is not set");
  }

  client = new MongoClient(mongoUri);
  await client.connect();
  db = client.db();
  console.log("MongoDB connected");

  return db;
}

function getDb() {
  if (!db) {
    throw new Error("MongoDB is not connected");
  }

  return db;
}

module.exports = {
  connectDB,
  getDb,
  get db() {
    return db;
  },
};
