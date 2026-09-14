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
  db = client.db(process.env.DB_NAME || undefined);
  console.log(MongoDB connected to database: );

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
