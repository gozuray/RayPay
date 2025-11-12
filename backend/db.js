// backend/db.js
import { MongoClient, ServerApiVersion } from "mongodb";

let client;
let db;

export async function connectMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("❌ Falta MONGODB_URI");

  // Crea el cliente aquí, cuando ya existe la env
  client = new MongoClient(uri, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
  });

  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    db = client.db("raypay");
    console.log("✅ MongoDB conectado (raypay)");

    // índices mínimos
    await db.collection("payments").createIndex({ signature: 1 }, { unique: true });
    await db.collection("payments").createIndex({ blockTime: -1 });
    await db.collection("merchants").createIndex({ email: 1 }, { unique: true });
  } catch (e) {
    console.error("❌ Error conectando Mongo:", e);
    process.exit(1);
  }
}

export function getDB() {
  if (!db) throw new Error("DB no inicializada");
  return db;
}
