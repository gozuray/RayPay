// backend/routes/admin.js
import express from "express";
import bcrypt from "bcryptjs";
import { ObjectId } from "mongodb";
import { getDB } from "../db.js";
import { verifyToken } from "../utils/auth.js";

const router = express.Router();

/**
 * Middleware: verifica que el token JWT sea válido
 * y que el usuario tenga role === "admin"
 */
function checkAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) {
    return res.status(401).json({ error: "Falta token" });
  }

  const token = auth.split(" ")[1];
  const data = verifyToken(token);

  if (!data || data.role !== "admin") {
    return res.status(403).json({ error: "No autorizado" });
  }

  // opcional: guardar info del admin
  req.admin = data;
  next();
}

/**
 * GET /admin/merchants
 * Lista todos los merchants
 */
router.get("/merchants", checkAdmin, async (req, res) => {
  try {
    const db = getDB();
    const merchants = await db
      .collection("merchants")
      .find({})
      .project({ password: 0 }) // no enviar hashes al front
      .toArray();

    res.json({ merchants });
  } catch (e) {
    console.error("admin /merchants:", e);
    res.status(500).json({ error: "Error al listar merchants" });
  }
});

/**
 * POST /admin/create
 * body: { username, wallet, password }
 */
router.post("/create", checkAdmin, async (req, res) => {
  try {
    const { username, wallet, password } = req.body || {};

    if (!username || !wallet || !password) {
      return res.status(400).json({ error: "Faltan campos" });
    }

    const db = getDB();
    const merchants = db.collection("merchants");

    const existing = await merchants.findOne({ username });
    if (existing) {
      return res.status(400).json({ error: "Ese usuario ya existe" });
    }

    const hashed = await bcrypt.hash(password, 10);

    await merchants.insertOne({
      username,
      wallet,
      password: hashed,
      role: "merchant",
    });

    res.json({ success: true });
  } catch (e) {
    console.error("admin /create:", e);
    res.status(500).json({ error: "Error al crear merchant" });
  }
});

/**
 * PUT /admin/merchant/:id
 * body: { username?, wallet?, password? }
 */
router.put("/merchant/:id", checkAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { username, wallet, password } = req.body || {};

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
  } catch (e) {
    console.error("admin PUT /merchant:", e);
    res.status(500).json({ error: "Error al editar merchant" });
  }
});

/**
 * DELETE /admin/merchant/:id
 */
router.delete("/merchant/:id", checkAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const db = getDB();
    await db.collection("merchants").deleteOne({ _id: new ObjectId(id) });

    res.json({ success: true });
  } catch (e) {
    console.error("admin DELETE /merchant:", e);
    res.status(500).json({ error: "Error al borrar merchant" });
  }
});

export default router;
