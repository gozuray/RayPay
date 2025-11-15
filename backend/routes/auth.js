// backend/routes/auth.js
import express from "express";
import bcrypt from "bcryptjs";
import { getDB } from "../db.js";
import { signToken } from "../utils/auth.js";
import { ObjectId } from "mongodb";

const router = express.Router();

// ⬇ LOGIN
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: "Usuario y contraseña requeridos" });
    }

    const db = getDB();
    const user = await db.collection("merchants").findOne({ username });

    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: "Contraseña incorrecta" });

    const token = signToken({
      id: user._id.toString(),
      username: user.username,
      role: user.role || "merchant",
    });

    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        wallet: user.wallet,
        role: user.role || "merchant",
      },
    });
  } catch (e) {
    console.error("login:", e);
    res.status(500).json({ error: "Error iniciando sesión" });
  }
});

export default router;
