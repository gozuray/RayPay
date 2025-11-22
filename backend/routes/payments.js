import express from "express";
import { PublicKey, Connection, Keypair, clusterApiUrl } from "@solana/web3.js";
import { encodeURL, findReference } from "@solana/pay";
import BigNumber from "bignumber.js";
import { getDB } from "../db.js";

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

// Home
router.get("/", (_req, res) => {
  res.send("RayPay Payments OK");
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

    let availableTotals = { ...totals };

    try {
      const merchant = await db
        .collection("merchants")
        .findOne({ wallet: merchantWallet });

      if (merchant?._id) {
        const claimSums = await db
          .collection("claims")
          .aggregate([
            { $match: { merchantId: merchant._id } },
            {
              $group: {
                _id: "$token",
                total: { $sum: "$amount" },
              },
            },
          ])
          .toArray();

        const claimedSol = claimSums.find((c) => c._id === "SOL")?.total || 0;
        const claimedUsdc = claimSums.find((c) => c._id === "USDC")?.total || 0;

        availableTotals = {
          SOL: Math.max((totals.SOL || 0) - claimedSol, 0),
          USDC: Math.max((totals.USDC || 0) - claimedUsdc, 0),
        };
      }
    } catch (claimErr) {
      console.warn("No se pudieron calcular los claims del merchant:", claimErr);
    }

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
      availableTotals,
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
