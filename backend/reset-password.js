// backend/reset-password.js
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import bcrypt from "bcryptjs";

dotenv.config();

const [,, username, newPassword] = process.argv;

if (!username || !newPassword) {
  console.log("Uso:");
  console.log("  node reset-password.js <username> <nuevaContraseña>");
  process.exit(1);
}

async function main() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || "raypay";

  if (!uri) {
    console.error("Falta MONGODB_URI en .env");
    process.exit(1);
  }

  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db(dbName);
    const merchants = db.collection("merchants");

    const hash = await bcrypt.hash(newPassword, 10);

    const result = await merchants.updateOne(
      { username },
      { $set: { password: hash } }
    );

    if (result.matchedCount === 0) {
      console.log(`❌ No se encontró usuario con username "${username}"`);
    } else {
      console.log(`✅ Contraseña actualizada para "${username}"`);
    }
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await client.close();
  }
}

main();
