// backend/db.js
import { MongoClient } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || "raypay";

let client;
let db;

/**
 * Conecta a Mongo y prepara índices de merchants
 */
export async function connectMongo() {
  if (db) return db; // ya conectado

  if (!MONGODB_URI) {
    throw new Error("Falta MONGODB_URI en .env");
  }

  try {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DB_NAME);

    console.log("✅ MongoDB conectado (raypay)");

    const merchants = db.collection("merchants");

    // 🧹 1) Intentar eliminar índice viejo por email (si existe)
    try {
      await merchants.dropIndex("email_1");
      console.log("ℹ️ Índice obsoleto email_1 eliminado");
    } catch (err) {
      // Código 27 = IndexNotFound
      if (err.codeName === "IndexNotFound" || err.code === 27) {
        console.log("ℹ️ Índice email_1 no existía, nada que borrar");
      } else {
        console.warn("⚠️ No se pudo eliminar índice email_1:", err.message);
      }
    }

    // 🧱 2) Crear índice ÚNICO por username (solo donde exista username)
    await merchants.createIndex(
      { username: 1 },
      {
        unique: true,
        partialFilterExpression: { username: { $exists: true } },
        name: "username_1_unique",
      }
    );
    console.log("✅ Índice único en username listo");

    return db;
  } catch (e) {
    console.error("❌ Error conectando Mongo:", e);
    throw e;
  }
}

/**
 * Devuelve la instancia de la DB ya conectada
 */
export function getDB() {
  if (!db) {
    throw new Error("MongoDB aún no inicializado. Llama primero a connectMongo()");
  }
  return db;
}
