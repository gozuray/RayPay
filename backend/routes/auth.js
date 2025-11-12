import express from "express";
import bcrypt from "bcryptjs";
import { getDB } from "../db.js";
import { signToken } from "../utils/auth.js";

const router = express.Router();

/**
 * POST /api/auth/register
 * body: { name, email, password, wallet }
 */
router.post("/register", async (req, res) => {
  try {
    const { name, email, password, wallet } = req.body || {};
    if (!name || !email || !password || !wallet) {
      return res.status(400).json({ error: "Campos incompletos" });
    }

    const db = getDB();
    const existing = await db.collection("merchants").findOne({ email });
    if (existing) return res.status(400).json({ error: "Email ya registrado" });

    const hashed = await bcrypt.hash(password, 10);
    const { insertedId } = await db.collection("merchants").insertOne({
      name, email, password: hashed, wallet, plan: "free", created_at: new Date(),
    });

    const token = signToken({ id: insertedId.toString(), email });
    res.json({ token, user: { id: insertedId, name, email, wallet, plan: "free" } });
  } catch (e) {
    console.error("register:", e);
    res.status(500).json({ error: "Error registrando usuario" });
  }
});

/**
 * POST /api/auth/login
 * body: { email, password }
 */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const db = getDB();
    const user = await db.collection("merchants").findOne({ email });
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: "Credenciales inválidas" });

    const token = signToken({ id: user._id.toString(), email: user.email });
    res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email, wallet: user.wallet, plan: user.plan },
    });
  } catch (e) {
    console.error("login:", e);
    res.status(500).json({ error: "Error iniciando sesión" });
  }
});

export default router;
