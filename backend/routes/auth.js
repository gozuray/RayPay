import express from "express";
import bcrypt from "bcryptjs";
import { getDB } from "../db.js";
import { signToken } from "../utils/auth.js";
import { ObjectId } from "mongodb";

const router = express.Router();

// LOGIN SOLO POR USERNAME
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: "Usuario y contraseña requeridos" });
    }

    const db = getDB();

    // SOLO username
    const user = await db.collection("merchants").findOne({ username });

    if (!user) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    // Validar contraseña
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.status(401).json({ error: "Contraseña incorrecta" });
    }

    // Token con rol
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
        destinationWallet: user.destinationWallet || "",
        role: user.role || "merchant",
      },
    });

  } catch (err) {
    console.error("login error:", err);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

export default router;
