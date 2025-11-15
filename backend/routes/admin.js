// backend/routes/admin.js
import express from "express";
import bcrypt from "bcryptjs";
import { ObjectId } from "mongodb";
import { Keypair } from "@solana/web3.js";
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

  req.admin = data;
  next();
}

/**
 * GET /admin/merchants
 */
router.get("/merchants", checkAdmin, async (req, res) => {
  try {
    const db = getDB();
    const merchants = await db
      .collection("merchants")
      .find({})
      .project({ password: 0 })
      .toArray();

    res.json({ merchants });
  } catch (e) {
    console.error("admin /merchants:", e);
    res.status(500).json({ error: "Error al listar merchants" });
  }
});

/**
 * POST /admin/create
 * body: { username, wallet?, walletMode?, password }
 */
router.post("/create", checkAdmin, async (req, res) => {
  try {
    const { username, wallet, password, walletMode } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: "Usuario y contraseña son obligatorios" });
    }

    const normalizedWalletMode = walletMode === "auto" ? "auto" : "manual";

    if (normalizedWalletMode === "manual" && !wallet) {
      return res.status(400).json({ error: "Debes indicar una wallet para el modo manual" });
    }

    const db = getDB();
    const merchants = db.collection("merchants");

    const existing = await merchants.findOne({ username });
    if (existing) {
      return res.status(400).json({ error: "Ese usuario ya existe" });
    }

    const hashed = await bcrypt.hash(password, 10);

    let walletAddress = wallet?.trim();
    let privateKeyBase64 = null;

    if (normalizedWalletMode === "auto") {
      const keypair = Keypair.generate();
      walletAddress = keypair.publicKey.toBase58();
      privateKeyBase64 = Buffer.from(keypair.secretKey).toString("base64");
    }

    const insertResult = await merchants.insertOne({
      username,
      wallet: walletAddress,
      password: hashed,
      role: "merchant",
    });

    if (privateKeyBase64) {
      await db.collection("privateKeys").insertOne({
        merchantId: insertResult.insertedId,
        merchantUsername: username,
        walletAddress,
        privateKey: privateKeyBase64,
        createdAt: new Date(),
        mode: normalizedWalletMode,
      });
    }

    res.json({
      success: true,
      merchant: {
        id: insertResult.insertedId.toString(),
        username,
        wallet: walletAddress,
      },
      wallet: privateKeyBase64
        ? {
            address: walletAddress,
            privateKey: privateKeyBase64,
          }
        : null,
    });
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
    const merchants = db.collection("merchants");
    const result = await merchants.updateOne(
      { _id: new ObjectId(id) },
      { $set: update }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Merchant no encontrado" });
    }

    if (wallet) {
      await db.collection("privateKeys").updateMany(
        { merchantId: new ObjectId(id) },
        { $set: { walletAddress: wallet } }
      );
    }

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
    const result = await db
      .collection("merchants")
      .deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Merchant no encontrado" });
    }

    await db.collection("privateKeys").deleteMany({ merchantId: new ObjectId(id) });

    res.json({ success: true });
  } catch (e) {
    console.error("admin DELETE /merchant:", e);
    res.status(500).json({ error: "Error al borrar merchant" });
  }
});

/**
 * GET /admin/keys
 * Devuelve las llaves privadas almacenadas para los merchants
 */
router.get("/keys", checkAdmin, async (_req, res) => {
  try {
    const db = getDB();
    const keys = await db
      .collection("privateKeys")
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ keys });
  } catch (e) {
    console.error("admin /keys:", e);
    res.status(500).json({ error: "Error al listar llaves" });
  }
});

export default router;
