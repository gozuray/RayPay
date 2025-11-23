import express from "express";
import bcrypt from "bcryptjs";
import { ObjectId } from "mongodb";
import {
  Keypair,
  Connection,
  clusterApiUrl,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { getDB } from "../db.js";
import { verifyToken as decodeToken } from "../utils/auth.js";
import Merchant from "../models/Merchant.js";
import Config from "../models/Config.js";
import mongoose from "../mongoose.js";

const router = express.Router();

const CLUSTER = process.env.SOLANA_CLUSTER || "mainnet-beta";
const RPC_URL = process.env.RPC_URL || clusterApiUrl(CLUSTER);
const connection = new Connection(RPC_URL, { commitment: "confirmed" });
const { Types } = mongoose;

// ⚡ Cache de balances para evitar rate limit
const BALANCE_CACHE_TTL_MS = Number(process.env.BALANCE_CACHE_TTL_MS || 30000);
const balanceCache = new Map();

const USDC_MINTS = {
  "mainnet-beta": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  devnet: "Gh9ZwEmdLJ8DscKNTkTqPBjAn6AoKkYzkvTzJk1io4k",
};

/**
 * Middleware: verifica token JWT y rol admin
 */
function verifyToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: "Falta token" });

  const token = auth.split(" ")[1];
  const data = decodeToken(token);

  if (!data) {
    return res.status(401).json({ error: "Token inválido" });
  }

  req.user = data;
  next();
}

function checkAdmin(req, res, next) {
  verifyToken(req, res, () => {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ error: "No autorizado" });
    }

    req.admin = req.user;
    next();
  });
}

router.get("/bot-qr", verifyToken, (_req, res) => {
  res.json({
    ready: false,
    qrDataUrl: null,
    updatedAt: new Date().toISOString(),
    state: "maintenance",
    lastError: "Bot en mantenimiento",
  });
});

function isValidPublicKey(address) {
  if (!address) return false;
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

async function getOrCreateConfig() {
  const existing = await Config.findOne();
  if (existing) return existing;
  return Config.create({ globalFeePercent: 0, globalFeeWallet: "" });
}

function validateFeePercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return { ok: false, error: "Porcentaje inválido" };
  if (numeric < 0 || numeric > 20) {
    return { ok: false, error: "El porcentaje debe estar entre 0 y 20" };
  }
  return { ok: true, value: numeric };
}

/* ============================
   RATE LIMIT & RPC RETRY HELPERS
============================ */

function isRateLimitError(error) {
  if (!error) return false;
  if (error.code === 429) return true;
  const msg = error.message || "";
  return msg.includes("429") || msg.includes("Too Many Requests");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRpcRetry(fn, retries = 2, delay = 500) {
  try {
    return await fn();
  } catch (error) {
    if (retries > 0 && isRateLimitError(error)) {
      console.warn(
        `RPC rate-limited, retrying in ${delay}ms (${retries} left)`
      );
      await wait(delay);
      return withRpcRetry(fn, retries - 1, delay * 2);
    }
    throw error;
  }
}

/* ============================
   CACHE HELPERS
============================ */

function readBalanceCache(walletAddress) {
  const cached = balanceCache.get(walletAddress);
  if (!cached) return null;

  if (Date.now() - cached.timestamp > BALANCE_CACHE_TTL_MS) {
    balanceCache.delete(walletAddress);
    return null;
  }

  return cached.balances;
}

function writeBalanceCache(walletAddress, balances) {
  if (walletAddress) {
    balanceCache.set(walletAddress, {
      balances,
      timestamp: Date.now(),
    });
  }
}

function clearBalanceCache(walletAddress) {
  if (walletAddress) balanceCache.delete(walletAddress);
}

/* ============================
   GET BALANCES
============================ */

async function getWalletBalances(walletAddress) {
  if (!walletAddress || !isValidPublicKey(walletAddress)) {
    console.warn("Wallet inválida para consulta:", walletAddress);
    return { sol: 0, usdc: 0 };
  }

  const cached = readBalanceCache(walletAddress);
  if (cached) return cached;

  try {
    const ownerPk = new PublicKey(walletAddress);

    const [solLamports, usdcBalance] = await Promise.all([
      withRpcRetry(() => connection.getBalance(ownerPk)).catch((e) => {
        console.error("getBalance error:", e);
        return 0;
      }),
      getUsdcBalance(ownerPk).catch(() => 0),
    ]);

    const balances = {
      sol: Number(solLamports) / LAMPORTS_PER_SOL,
      usdc: usdcBalance,
    };

    writeBalanceCache(walletAddress, balances);
    return balances;
  } catch (error) {
    console.error("getWalletBalances fatal:", error);
    return { sol: 0, usdc: 0 };
  }
}

async function getUsdcBalance(ownerPk) {
  const mintAddress = USDC_MINTS[CLUSTER];
  if (!mintAddress) return 0;

  try {
    const mintPk = new PublicKey(mintAddress);

    const response = await withRpcRetry(() =>
      connection.getParsedTokenAccountsByOwner(ownerPk, { mint: mintPk })
    );

    const tokenInfo =
      response?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount;

    return Number(tokenInfo?.uiAmount ?? 0);
  } catch (error) {
    if (isRateLimitError(error)) {
      console.warn("Rate limit en getUsdcBalance, devolviendo 0");
    } else {
      console.error("getUsdcBalance error:", error);
    }
    return 0;
  }
}

/* ============================
   RUTAS ADMIN
============================ */

/**
 * GET /admin/merchants
 * Devuelve merchants + totales recibidos + wallet registrada
 */
router.get("/merchants", checkAdmin, async (req, res) => {
  try {
    const db = getDB();

    const merchants = await Merchant.find({}, { password: 0 })
      .lean()
      .exec();

    const paymentSums = await db
      .collection("payments")
      .aggregate([
        { $match: { status: "success" } },
        {
          $group: {
            _id: { merchantWallet: "$merchantWallet", token: "$token" },
            totalAmount: { $sum: "$amount" },
          },
        },
      ])
      .toArray();

    const paymentMap = new Map();
    paymentSums.forEach(({ _id, totalAmount }) => {
      const wallet = _id?.merchantWallet;
      const token = (_id?.token || "SOL").toUpperCase() === "USDC"
        ? "USDC"
        : "SOL";
      if (!wallet) return;
      if (!paymentMap.has(wallet)) {
        paymentMap.set(wallet, { SOL: 0, USDC: 0 });
      }
      paymentMap.get(wallet)[token] = Number(totalAmount) || 0;
    });

    const enriched = merchants.map((merchant) => {
      const registeredWallet = (merchant.destinationWallet || merchant.wallet || "").trim();
      const walletStats = registeredWallet ? paymentMap.get(registeredWallet) : null;

      const solIncome = walletStats?.SOL ?? 0;
      const usdcIncome = walletStats?.USDC ?? 0;

      const receivedTotals = {
        sol: Number(solIncome),
        usdc: Number(usdcIncome),
      };

      return {
        ...merchant,
        registeredWallet,
        receivedTotals,
        feePercent: merchant.feePercent ?? null,
      };
    });

    res.json({
      merchants: enriched,
    });
  } catch (e) {
    console.error("admin /merchants:", e);
    res.status(500).json({ error: "Error al listar merchants" });
  }
});

router.put("/merchants/:id/fee", checkAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { feePercent } = req.body || {};

    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID de merchant inválido" });
    }

    const validation = validateFeePercent(feePercent);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }

    const updated = await Merchant.findByIdAndUpdate(
      id,
      { feePercent: validation.value },
      { new: true }
    )
      .lean()
      .exec();

    if (!updated) {
      return res.status(404).json({ error: "Merchant no encontrado" });
    }

    res.json({
      success: true,
      merchant: {
        id: updated._id,
        feePercent: updated.feePercent,
      },
    });
  } catch (e) {
    console.error("admin PUT /merchants/:id/fee:", e);
    res.status(500).json({ error: "Error al actualizar comisión" });
  }
});

router.get("/config", checkAdmin, async (_req, res) => {
  try {
    const config = await getOrCreateConfig();
    res.json({
      globalFeePercent: config.globalFeePercent,
      globalFeeWallet: config.globalFeeWallet,
      updatedAt: config.updatedAt,
    });
  } catch (e) {
    console.error("admin GET /config:", e);
    res.status(500).json({ error: "Error al obtener configuración" });
  }
});

router.put("/config", checkAdmin, async (req, res) => {
  try {
    const { globalFeePercent, globalFeeWallet } = req.body || {};

    const validation = validateFeePercent(globalFeePercent);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }

    if (!globalFeeWallet || !isValidPublicKey(globalFeeWallet)) {
      return res.status(400).json({ error: "Wallet de comisiones inválida" });
    }

    const updated = await Config.findOneAndUpdate(
      {},
      { globalFeePercent: validation.value, globalFeeWallet },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    )
      .lean()
      .exec();

    res.json({
      success: true,
      globalFeePercent: updated.globalFeePercent,
      globalFeeWallet: updated.globalFeeWallet,
      updatedAt: updated.updatedAt,
    });
  } catch (e) {
    console.error("admin PUT /config:", e);
    res.status(500).json({ error: "Error al guardar configuración" });
  }
});

/**
 * POST /admin/create
 * Crea merchant (manual o auto wallet)
 */
router.post("/create", checkAdmin, async (req, res) => {
  try {
    const { username, wallet, password, walletMode, destinationWallet } =
      req.body || {};

    if (!username || !password) {
      return res
        .status(400)
        .json({ error: "Usuario y contraseña son obligatorios" });
    }

    const normalizedWalletMode = walletMode === "auto" ? "auto" : "manual";

    if (normalizedWalletMode === "manual" && !wallet) {
      return res
        .status(400)
        .json({ error: "Debes indicar una wallet para el modo manual" });
    }

    if (wallet && !isValidPublicKey(wallet)) {
      return res.status(400).json({ error: "Wallet manual inválida" });
    }

    if (destinationWallet && !isValidPublicKey(destinationWallet)) {
      return res.status(400).json({ error: "Wallet de destino inválida" });
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

    // Generar wallet automática
    if (normalizedWalletMode === "auto") {
      const keypair = Keypair.generate();
      walletAddress = keypair.publicKey.toBase58();
      privateKeyBase64 = Buffer.from(keypair.secretKey).toString("base64");
    }

    // Insertar merchant
    const insertResult = await merchants.insertOne({
      username,
      wallet: walletAddress,
      destinationWallet: destinationWallet?.trim() || "",
      password: hashed,
      role: "merchant",
      feePercent: null,
    });

    // Guardar private key si fue auto
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
        destinationWallet: destinationWallet?.trim() || "",
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
 * Edita merchant
 */
router.put("/merchant/:id", checkAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { username, wallet, password } = req.body || {};

    const db = getDB();
    const merchants = db.collection("merchants");

    const merchant = await merchants.findOne({ _id: new ObjectId(id) });
    if (!merchant) {
      return res.status(404).json({ error: "Merchant no encontrado" });
    }

    const update = {};

    if (username) update.username = username;

    if (wallet) {
      if (!isValidPublicKey(wallet)) {
        return res.status(400).json({ error: "Wallet inválida" });
      }
      update.wallet = wallet;
      clearBalanceCache(merchant.wallet);
      clearBalanceCache(wallet);
    }

    if (password) update.password = await bcrypt.hash(password, 10);

    if (Object.keys(update).length === 0) {
      return res.json({ success: true });
    }

    await merchants.updateOne({ _id: merchant._id }, { $set: update });

    // sync private keys if wallet changed
    if (wallet) {
      await db.collection("privateKeys").updateMany(
        { merchantId: merchant._id },
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
 * Elimina merchant + llaves + claims
 */
router.delete("/merchant/:id", checkAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const db = getDB();
    const merchants = db.collection("merchants");

    const merchant = await merchants.findOne({ _id: new ObjectId(id) });
    if (!merchant) {
      return res.status(404).json({ error: "Merchant no encontrado" });
    }

    // Borrar merchant
    await merchants.deleteOne({ _id: merchant._id });

    // Borrar llaves privadas asociadas
    await db.collection("privateKeys").deleteMany({
      merchantId: merchant._id,
    });

    // Borrar claims del merchant
    await db.collection("claims").deleteMany({
      merchantId: merchant._id,
    });

    // Limpiar cache
    clearBalanceCache(merchant.wallet);

    res.json({ success: true });
  } catch (e) {
    console.error("admin DELETE /merchant:", e);
    res.status(500).json({ error: "Error al borrar merchant" });
  }
});

/**
 * GET /admin/keys
 * Lista llaves privadas de merchants automáticos
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

/* ============================
   EXPORT
============================ */

export default router;
