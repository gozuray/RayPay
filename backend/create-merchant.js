// backend/create-merchant.js
import bcrypt from "bcryptjs";
import { MongoClient } from "mongodb";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const [username, wallet, password] = process.argv.slice(2);

  if (!username || !wallet || !password) {
    console.log("Uso:");
    console.log("node create-merchant.js <username> <wallet> <password>");
    return;
  }

  const hash = await bcrypt.hash(password, 10);

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();

  const db = client.db(process.env.DB_NAME || "raypay");
  const merchants = db.collection("merchants");

  // Validar si ya existe
  const existing = await merchants.findOne({ username });
  if (existing) {
    console.log("❌ Ese username ya existe");
    client.close();
    return;
  }

  const doc = {
    username,
    password: hash,
    wallet,
  };

  await merchants.insertOne(doc);

  console.log("✅ Merchant creado con éxito:");
  console.log(doc);

  client.close();
}

main().catch(console.error);
