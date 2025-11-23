import express from "express";
import {
  PublicKey,
  Connection,
  Keypair,
  clusterApiUrl,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { encodeURL, findReference } from "@solana/pay";
import BigNumber from "bignumber.js";
import { getDB } from "../db.js";
import { verifyToken as decodeToken } from "../utils/auth.js";
import { ObjectId } from "mongodb";
import Merchant from "../models/Merchant.js";
import Config from "../models/Config.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";

const router = express.Router();

// ⚙️ Configuración básica
const CLUSTER = process.env.SOLANA_CLUSTER || "mainnet-beta";
const MERCHANT_WALLET = (process.env.MERCHANT_WALLET || "").trim();
const RPC_URL = process.env.RPC_URL || clusterApiUrl(CLUSTER);

if (!MERCHANT_WALLET) {
  console.error("⚠️ Falta MERCHANT_WALLET en .env (se usará sólo si no llega una wallet desde el frontend)");
}

const USDC_MINTS = {
  "mainnet-beta": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  devnet: "Gh9ZwEmdLJ8DscKNTkTqPBjAn6AoKkYzkvTzJk1io4k",
};

const connection = new Connection(RPC_URL, {
  commitment: "confirmed",
  confirmTransactionInitialTimeout: 60000,
});

const toBN = (v) => new BigNumber(String(v));

// Reutilizamos el objeto global
if (!global.pendingPayments) global.pendingPayments = {};

const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 8 ? digits : "";
};

const isValidPublicKey = (address) => {
  if (!address) return false;
  try {
    new PublicKey(address);
    return true;
  } catch (err) {
    return false;
  }
};

async function getOrCreateConfig() {
  const existing = await Config.findOne();
  if (existing) return existing;
  return Config.create({ globalFeePercent: 0, globalFeeWallet: "" });
}

function validateAmountToLamports(rawAmount, token) {
  const amountBN = new BigNumber(String(rawAmount || "")).multipliedBy(1);
  if (!amountBN.isFinite() || amountBN.lte(0)) {
    throw new Error("Monto inválido");
  }

  const decimals = token === "SOL" ? 9 : 6;
  const base = new BigNumber(10).pow(decimals);
  const lamports = amountBN.multipliedBy(base).integerValue(BigNumber.ROUND_FLOOR);

  return {
    lamports: lamports.toNumber(),
    decimals,
  };
}

function calculateSplit(totalLamports, feePercent) {
  const feeLamports = Math.floor(totalLamports * (feePercent / 100));
  const merchantAmount = totalLamports - feeLamports;
  if (merchantAmount < 0) {
    throw new Error("El fee no puede exceder el monto total");
  }
  return { feeLamports, merchantAmount };
}

async function ensureAtaInstructions({ mint, owner, payer }) {
  const ata = await getAssociatedTokenAddress(mint, owner, true);
  const info = await connection.getAccountInfo(ata);
  const instructions = [];
  if (!info) {
    instructions.push(
      createAssociatedTokenAccountInstruction(payer, ata, owner, mint)
    );
  }
  return { ata, instructions };
}

function requireMerchantAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.split(" ")[1]
    : "";

  const decoded = decodeToken(token);

  if (!decoded?.id) {
    return res.status(401).json({ error: "Token inválido o faltante" });
  }

  req.user = decoded;
  next();
}

// Home
router.get("/", (_req, res) => {
  res.send("RayPay Payments OK");
});

// 🔐 Leer wallet de destino configurada por el merchant
router.get(
  "/merchant/destination-wallet",
  requireMerchantAuth,
  async (req, res) => {
    try {
      const db = getDB();
      const merchant = await db
        .collection("merchants")
        .findOne({ _id: new ObjectId(req.user.id) });

      return res.json({
        destinationWallet: merchant?.destinationWallet?.trim() || "",
      });
    } catch (error) {
      console.error("GET /merchant/destination-wallet:", error);
      return res
        .status(500)
        .json({ error: "No se pudo obtener la wallet de retiro" });
    }
  }
);

// 🔐 Guardar wallet de destino configurada por el merchant
router.put(
  "/merchant/destination-wallet",
  requireMerchantAuth,
  async (req, res) => {
    try {
      const { destinationWallet } = req.body || {};
      const cleanWallet = (destinationWallet || "").trim();

      if (!cleanWallet) {
        return res
          .status(400)
          .json({ error: "Ingresa una wallet pública para retiros" });
      }

      if (!isValidPublicKey(cleanWallet)) {
        return res.status(400).json({ error: "Wallet de retiro inválida" });
      }

      const db = getDB();
      const merchants = db.collection("merchants");

      const result = await merchants.updateOne(
        { _id: new ObjectId(req.user.id) },
        { $set: { destinationWallet: cleanWallet } }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ error: "Merchant no encontrado" });
      }

      return res.json({ success: true, destinationWallet: cleanWallet });
    } catch (error) {
      console.error("PUT /merchant/destination-wallet:", error);
      return res
        .status(500)
        .json({ error: "No se pudo guardar la wallet de retiro" });
    }
  }
);

router.post("/api/payments/create", async (req, res) => {
  try {
    const { amount, token = "USDC", merchantId, payer, restaurant } = req.body || {};
    const chosenToken = token === "SOL" ? "SOL" : "USDC";

    if (!merchantId || !ObjectId.isValid(merchantId)) {
      return res.status(400).json({ error: "merchantId inválido" });
    }

    if (!payer || !isValidPublicKey(payer)) {
      return res.status(400).json({ error: "Wallet del pagador inválida" });
    }

    const merchant = await Merchant.findById(merchantId).lean().exec();
    if (!merchant) {
      return res.status(404).json({ error: "Merchant no encontrado" });
    }

    const recipientWallet = (merchant.destinationWallet || merchant.wallet || "").trim();
    if (!recipientWallet || !isValidPublicKey(recipientWallet)) {
      return res
        .status(400)
        .json({ error: "El merchant no tiene una wallet válida configurada" });
    }

    const { lamports: totalLamports } = validateAmountToLamports(amount, chosenToken);

    const config = await getOrCreateConfig();
    const hasMerchantFee =
      merchant.feePercent !== null && merchant.feePercent !== undefined;
    const feePercent = hasMerchantFee
      ? merchant.feePercent
      : config.globalFeePercent || 0;

    const { feeLamports, merchantAmount } = calculateSplit(
      totalLamports,
      feePercent
    );

    if (feeLamports > 0 && !config.globalFeeWallet) {
      return res.status(400).json({ error: "Wallet global de comisiones no configurada" });
    }

    if (feeLamports > 0 && !isValidPublicKey(config.globalFeeWallet)) {
      return res.status(400).json({ error: "Wallet global de comisiones inválida" });
    }

    const payerPk = new PublicKey(payer);
    const merchantPk = new PublicKey(recipientWallet);
    const feeWalletPk =
      feeLamports > 0 && config.globalFeeWallet
        ? new PublicKey(config.globalFeeWallet)
        : null;

    if (merchantAmount <= 0) {
      return res.status(400).json({ error: "El monto para el merchant debe ser mayor a 0" });
    }

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const transaction = new Transaction({ feePayer: payerPk, blockhash, lastValidBlockHeight });

    if (chosenToken === "SOL") {
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: payerPk,
          toPubkey: merchantPk,
          lamports: merchantAmount,
        })
      );

      if (feeWalletPk && feeLamports > 0) {
        transaction.add(
          SystemProgram.transfer({
            fromPubkey: payerPk,
            toPubkey: feeWalletPk,
            lamports: feeLamports,
          })
        );
      }
    } else {
      const usdcMint = USDC_MINTS[CLUSTER];
      if (!usdcMint) {
        return res.status(400).json({ error: "Mint de USDC no disponible para el cluster" });
      }

      const mintPk = new PublicKey(usdcMint);

      const [payerAtaInfo, merchantAtaInfo, feeAtaInfo] = await Promise.all([
        ensureAtaInstructions({ mint: mintPk, owner: payerPk, payer: payerPk }),
        ensureAtaInstructions({ mint: mintPk, owner: merchantPk, payer: payerPk }),
        feeWalletPk
          ? ensureAtaInstructions({ mint: mintPk, owner: feeWalletPk, payer: payerPk })
          : Promise.resolve({ ata: null, instructions: [] }),
      ]);

      [...payerAtaInfo.instructions, ...merchantAtaInfo.instructions, ...feeAtaInfo.instructions].forEach(
        (ix) => transaction.add(ix)
      );

      transaction.add(
        createTransferInstruction(
          payerAtaInfo.ata,
          merchantAtaInfo.ata,
          payerPk,
          BigInt(merchantAmount)
        )
      );

      if (feeWalletPk && feeLamports > 0 && feeAtaInfo.ata) {
        transaction.add(
          createTransferInstruction(
            payerAtaInfo.ata,
            feeAtaInfo.ata,
            payerPk,
            BigInt(feeLamports)
          )
        );
      }
    }

    const serialized = transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");

    res.json({
      transaction: serialized,
      token: chosenToken,
      cluster: CLUSTER,
      feePercent,
      feeLamports,
      merchantLamports: merchantAmount,
      totalLamports,
      merchantWallet: recipientWallet,
      feeWallet: config.globalFeeWallet,
      restaurant: restaurant || merchant.username,
    });
  } catch (error) {
    console.error("/api/payments/create error:", error);
    res.status(500).json({ error: error.message || "No se pudo crear la transacción" });
  }
});

// 🟣 Crear pago (QR) — soporta multi-merchant
router.post("/create-payment", (req, res) => {
  try {
    let { amount, restaurant, token, merchantWallet, phoneNumber } =
      req.body || {};

    // Normalizar monto para evitar NaN cuando el cliente envía comas o símbolos
    const sanitizedAmount = String(amount || "")
      .replace(",", ".")
      .replace(/[^0-9.]/g, "")
      .split(".")
      .filter((chunk, index) => chunk !== "" || index === 0)
      .join(".");

    const chosenToken = token === "SOL" ? "SOL" : "USDC";
    const decimals = chosenToken === "SOL" ? 5 : 3;

    const numericAmount = Number(parseFloat(sanitizedAmount).toFixed(decimals));

    if (!numericAmount || Number.isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ error: "Monto inválido" });
    }

    amount = numericAmount.toFixed(decimals);

    // 1️⃣ Determinar qué wallet usar
    const bodyWallet = (merchantWallet || "").trim();
    const walletStr = bodyWallet || MERCHANT_WALLET;

    if (!walletStr) {
      return res
        .status(500)
        .json({ error: "No hay wallet de comercio configurada" });
    }

    let recipientPk;
    try {
      recipientPk = new PublicKey(walletStr);
    } catch (e) {
      console.error("Wallet inválida recibida:", walletStr);
      return res.status(400).json({ error: "Wallet del comercio inválida" });
    }

    const usdcMint = USDC_MINTS[CLUSTER];
    const reference = Keypair.generate().publicKey;
    const amountBN = toBN(amount);

    const url = encodeURL({
      recipient: recipientPk,
      amount: amountBN,
      splToken:
        chosenToken === "USDC" ? new PublicKey(usdcMint) : undefined,
      label: restaurant || "Restaurante",
      message: `Pago en ${chosenToken}`,
      reference,
    });

    const refStr = reference.toBase58();
    global.pendingPayments[refStr] = {
      amount: amountBN.toString(),
      token: chosenToken,
      created: new Date().toISOString(),
      restaurant: restaurant || "Restaurante",
      merchantWallet: walletStr, // 👉 guardamos la wallet usada en este pago
      phoneNumber: normalizePhone(phoneNumber),
    };

    res.json({
      success: true,
      solana_url: url.toString(),
      token: chosenToken,
      cluster: CLUSTER,
      reference: refStr,
    });
  } catch (err) {
    console.error("Error en /create-payment:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Confirmar y guardar en Mongo
router.get("/confirm/:reference", async (req, res) => {
  const { reference } = req.params;
  const payment = global.pendingPayments[reference];
  const db = getDB();
  const payments = db.collection("payments");

  if (!payment) return res.status(404).json({ error: "Referencia no encontrada" });

  try {
    const existing = await payments.findOne({ reference });
    if (existing) {
      return res.json({
        status: "pagado",
        signature: existing.signature,
        fromCache: true,
      });
    }

    const referenceKey = new PublicKey(reference);
    const sigInfo = await findReference(connection, referenceKey, {
      finality: "confirmed",
    });

    if (!sigInfo?.signature) {
      return res.json({ status: "pendiente" });
    }

    const tx = await connection.getParsedTransaction(sigInfo.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta) return res.json({ status: "pendiente" });

    // 👇 Usamos la wallet del pago, o la global como fallback
    const merchant = (payment.merchantWallet || MERCHANT_WALLET || "").trim();
    const expectedAmount = parseFloat(payment.amount);
    let received = 0;

    if (payment.token === "SOL") {
      const pre = tx.meta.preBalances;
      const post = tx.meta.postBalances;
      const keys = tx.transaction.message.accountKeys.map((k) =>
        k.pubkey.toBase58()
      );
      const index = keys.indexOf(merchant);
      if (index >= 0) {
        received = (post[index] - pre[index]) / 1e9;
      }
    } else {
      const usdcMint = USDC_MINTS[CLUSTER];
      const postToken = tx.meta.postTokenBalances?.find(
        (b) => b.owner === merchant && b.mint === usdcMint
      );
      const preToken = tx.meta.preTokenBalances?.find(
        (b) => b.owner === merchant && b.mint === usdcMint
      );
      const postAmount = postToken?.uiTokenAmount?.uiAmount ?? 0;
      const preAmount = preToken?.uiTokenAmount?.uiAmount ?? 0;
      received = postAmount - preAmount;
    }

    if (received >= expectedAmount - 0.00001) {
      const keys = tx.transaction.message.accountKeys.map((k) =>
        k.pubkey.toBase58()
      );
      const payer = keys[0] || "desconocido";
      const blockTime = tx.blockTime ? tx.blockTime * 1000 : Date.now();

      const doc = {
        signature: sigInfo.signature,
        reference,
        token: payment.token,
        amount: Number(
          received.toFixed(payment.token === "SOL" ? 9 : 6)
        ),
        expectedAmount,
        merchantWallet: merchant,
        payer,
        fee: tx.meta.fee / 1e9,
        slot: tx.slot || 0,
        blockTime,
        date: new Date(blockTime).toLocaleDateString("es-ES"),
        time: new Date(blockTime).toLocaleTimeString("es-ES"),
        status: "success",
        restaurant: payment.restaurant || "Restaurante",
        cluster: CLUSTER,
        createdAt: new Date(),
      };

      try {
        await payments.insertOne(doc);
      } catch (e) {
        if (e.code !== 11000) console.error("Mongo insert error:", e);
      }

      delete global.pendingPayments[reference];

      return res.json({
        status: "pagado",
        signature: sigInfo.signature,
        amount: received,
        savedToDatabase: true,
      });
    }

    return res.json({ status: "pendiente" });
  } catch (err) {
    if (err.message?.includes("not found")) {
      return res.json({ status: "pendiente" });
    }
    console.error("Error en /confirm:", err);
    res.status(500).json({ error: err.message });
  }
});

// 📜 Historial desde MongoDB (filtrado por merchant)
router.get("/transactions", async (req, res) => {
  try {
    const db = getDB();
    const payments = db.collection("payments");

    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
    const filterToken = req.query.token?.toUpperCase();
    const skip = parseInt(req.query.skip || "0", 10);

    const merchantWallet = (req.query.wallet || MERCHANT_WALLET || "").trim();
    if (!merchantWallet) {
      return res
        .status(400)
        .json({ error: "No se especificó merchantWallet", data: [], total: 0 });
    }

    const filter = { merchantWallet };
    if (filterToken && (filterToken === "SOL" || filterToken === "USDC")) {
      filter.token = filterToken;
    }

    const rows = await payments
      .find(filter)
      .sort({ blockTime: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();
    const total = await payments.countDocuments(filter);

    const stats = await payments
      .aggregate([
        { $match: filter },
        {
          $group: {
            _id: "$token",
            total: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray();

    const totals = {
      SOL: stats.find((s) => s._id === "SOL")?.total || 0,
      USDC: stats.find((s) => s._id === "USDC")?.total || 0,
    };

    res.json({
      data: rows.map((tx) => ({
        reference: tx.reference,
        signature: tx.signature,
        token: tx.token,
        amount: tx.amount,
        payer: tx.payer,
        fee: tx.fee,
        slot: tx.slot,
        blockTime: tx.blockTime,
        date: tx.date,
        time: tx.time,
        status: tx.status,
        restaurant: tx.restaurant,
      })),
      total,
      returned: rows.length,
      filterToken: filterToken || "all",
      totals,
      availableTotals: totals,
    });
  } catch (e) {
    console.error("transactions:", e);
    res.status(500).json({ error: e.message, data: [], total: 0 });
  }
});

router.post("/receipt/:reference", async (_req, res) => {
  res.status(503).json({
    error:
      "El envío de recibos por WhatsApp está en mantenimiento. Inténtalo más tarde.",
  });
});

// 📥 CSV de transacciones
router.get("/transactions/download", async (req, res) => {
  try {
    const db = getDB();
    const payments = db.collection("payments");

    const filterToken = req.query.token?.toUpperCase();
    const merchantWallet = (req.query.wallet || MERCHANT_WALLET || "").trim();
    if (!merchantWallet) {
      return res.status(400).send("Falta merchantWallet");
    }

    const filter = { merchantWallet };
    if (filterToken && (filterToken === "SOL" || filterToken === "USDC")) {
      filter.token = filterToken;
    }

    const txs = await payments
      .find(filter)
      .sort({ blockTime: -1 })
      .limit(500)
      .toArray();
    if (txs.length === 0) {
      return res.status(404).send("No hay transacciones para descargar");
    }

    const csv =
      "Signature,Token,Monto,Pagador,Fee,Slot,Fecha,Hora,Estado,Restaurante\n" +
      txs
        .map(
          (t) =>
            `"${t.signature}","${t.token}","${t.amount}","${t.payer}","${t.fee}","${t.slot}","${t.date}","${t.time}","${t.status}","${
              t.restaurant || "N/A"
            }"`
        )
        .join("\n");

    res.header("Content-Type", "text/csv; charset=utf-8");
    res.attachment(
      `transacciones_${new Date().toISOString().split("T")[0]}.csv`
    );
    res.send(csv);
  } catch (e) {
    console.error("csv:", e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
