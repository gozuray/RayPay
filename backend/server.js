import express from "express";
import cors from "cors";
import { PublicKey, Connection, clusterApiUrl, Keypair } from "@solana/web3.js";
import { encodeURL, findReference } from "@solana/pay";
import BigNumber from "bignumber.js";
import dotenv from "dotenv";

dotenv.config();

const app = express();

// ✅ CORS: permite localhost y Live Server
app.use(
  cors({
    origin: [
      "http://127.0.0.1:5500", // VSCode Live Server
      "http://localhost:5500", // Live Server alternativa
      "http://127.0.0.1:3000", // backend local
      "http://localhost:3000", // backend local
      "https://raypay-1.onrender.com",
    ],
    methods: ["GET", "POST", "OPTIONS"],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  })
);

app.use(express.json());

// (Opcional) endpoint base para probar conexión rápida
app.get("/", (_req, res) => {
  res.send("✅ RayPay backend local funcionando correctamente.");
});

// ⚙️ Configuración base
const CLUSTER = process.env.SOLANA_CLUSTER || "mainnet-beta";
const MERCHANT_WALLET = (process.env.MERCHANT_WALLET || "").trim();
if (!MERCHANT_WALLET)
  throw new Error("❌ Falta MERCHANT_WALLET en archivo .env");

const USDC_MINTS = {
  "mainnet-beta": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  devnet: "Gh9ZwEmdLJ8DscKNTkTqPBjAn6AoKkYzkvTzJk1io4k",
};

const connection = new Connection(clusterApiUrl(CLUSTER));

// 🧾 Historial en memoria
global.payments = {};

const toBN = (v) => new BigNumber(String(v));

/**
 * POST /create-payment
 * body: { amount, token("USDC"|"SOL"), restaurant }
 */
app.post("/create-payment", (req, res) => {
  try {
    let { amount, restaurant, token } = req.body;

    if (amount === undefined || isNaN(Number(amount))) {
      return res.status(400).json({ error: "Monto inválido" });
    }

    const chosenToken = token === "SOL" ? "SOL" : "USDC";
    amount = parseFloat(amount).toFixed(chosenToken === "SOL" ? 5 : 3);

    const usdcMint = USDC_MINTS[CLUSTER];

    // Referencia única por transacción
    const reference = Keypair.generate().publicKey;
    const amountBN = toBN(amount);

    const url = encodeURL({
      recipient: new PublicKey(MERCHANT_WALLET),
      amount: amountBN,
      splToken: chosenToken === "USDC" ? new PublicKey(usdcMint) : undefined,
      label: restaurant || "Restaurante Lisboa",
      message: `Pago en ${chosenToken}`,
      reference,
    });

    global.payments[reference.toBase58()] = {
      amount: amountBN.toString(),
      token: chosenToken,
      status: "pendiente",
      created: new Date().toISOString(),
    };

    console.log(
      `[${CLUSTER}] 💰 Nuevo pago: ${amountBN.toString()} ${chosenToken}`
    );
    console.log(`Referencia: ${reference.toBase58()}`);

    res.json({
      success: true,
      solana_url: url.toString(),
      token: chosenToken,
      cluster: CLUSTER,
      reference: reference.toBase58(),
    });
  } catch (err) {
    console.error("Error en /create-payment:", err);
    res.status(500).json({ error: "Error generando el pago", details: err.message });
  }
});

/**
 * GET /confirm/:reference
 * Verifica si el pago fue confirmado on-chain
 */
app.get("/confirm/:reference", async (req, res) => {
  const { reference } = req.params;
  const payment = global.payments[reference];

  if (!payment) return res.status(404).json({ error: "Referencia no encontrada" });

  try {
    const referenceKey = new PublicKey(reference);
    const sigInfo = await findReference(connection, referenceKey, {
      finality: "confirmed",
    });

    if (!sigInfo || !sigInfo.signature) {
      return res.json({ status: "pendiente" });
    }

    const tx = await connection.getParsedTransaction(sigInfo.signature, {
      commitment: "confirmed",
    });

    if (!tx || !tx.meta) {
      return res.json({ status: "pendiente" });
    }

    // ✅ Validación manual del destinatario y monto
    const merchant = MERCHANT_WALLET;
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
        const diffLamports = post[index] - pre[index];
        received = diffLamports / 1e9;
      }
    } else {
      const postToken = tx.meta.postTokenBalances.find(
        (b) => b.owner === merchant
      );
      if (postToken) {
        received = parseFloat(postToken.uiTokenAmount.uiAmountString);
      }
    }

    // Comparar con tolerancia mínima
    if (received >= expectedAmount - 0.00001) {
      payment.status = "pagado";
      payment.signature = sigInfo.signature;
      console.log(`✅ Pago confirmado (${payment.token}): ${received}`);
      return res.json({ status: "pagado", signature: sigInfo.signature });
    } else {
      console.log(
        `⚠️ Monto recibido ${received} no coincide con ${expectedAmount}`
      );
      return res.json({ status: "pendiente" });
    }
  } catch (err) {
    if (err.message?.includes("not found")) {
      return res.json({ status: "pendiente" });
    } else {
      console.error("Error verificando pago:", err);
      return res
        .status(500)
        .json({ error: "Error al verificar el pago", details: err.message });
    }
  }
});

// 🧾 Historial
app.get("/history", (req, res) => {
  res.json(global.payments);
});

// 🚀 Servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor en http://localhost:${PORT} [${CLUSTER}]`);
});
