import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || "raypay";

let isConnected = false;

export async function connectMongoose() {
  if (isConnected) return mongoose.connection;

  if (!MONGODB_URI) {
    throw new Error("Falta MONGODB_URI para conectar mongoose");
  }

  mongoose.set("strictQuery", true);
  await mongoose.connect(MONGODB_URI, { dbName: DB_NAME });
  isConnected = true;
  return mongoose.connection;
}

export default mongoose;
