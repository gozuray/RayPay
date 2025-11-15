import express from "express";
import { getDB } from "../db.js";
import { verifyToken } from "../utils/auth.js";
import bcrypt from "bcryptjs";
import { ObjectId } from "mongodb";

const router = express.Router();

// 1️⃣ Verificar si es admin
function checkAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: "Falta token" });

  const token = auth.split(" ")[1];
  const data = verifyToken(token);

  if (!data || data.role !== "admin") {
    return res.status(403).json({ error: "No autorizado" });
  }

  next();
}

// 2️⃣ Obtener todos los merchants
router.get("/merchants", checkAdmin, async (req, res) => {
  const db = getDB();
  const merchants = await db.collection("merchants").find({}).toArray();
  res.json({ merchants });
});

// 3️⃣ Crear merchant
router.post("/create", checkAdmin, async (req, res) => {
  const { username, wallet, password } = req.body;
  const hashed = await bcrypt.hash(password, 10);

  const db = getDB();
  await db.collection("merchants").insertOne({
    username,
    wallet,
    password: hashed,
    role: "merchant",
  });

  res.json({ success: true });
});

// 4️⃣ Editar merchant
router.put("/merchant/:id", checkAdmin, async (req, res) => {
  const { username, wallet, password } = req.body;
  const id = req.params.id;

  const update = {};
  if (username) update.username = username;
  if (wallet) update.wallet = wallet;
  if (password) update.password = await bcrypt.hash(password, 10);

  const db = getDB();
  await db.collection("merchants").updateOne(
    { _id: new ObjectId(id) },
    { $set: update }
  );

  res.json({ success: true });
});

// 5️⃣ Borrar merchant
router.delete("/merchant/:id", checkAdmin, async (req, res) => {
  const id = req.params.id;
  const db = getDB();
  await db.collection("merchants").deleteOne({ _id: new ObjectId(id) });

  res.json({ success: true });
});

export default router;
