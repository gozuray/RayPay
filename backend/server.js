import express from "express";
import cors from "cors";
import { PublicKey, Connection, clusterApiUrl, Keypair } from "@solana/web3.js";
import { encodeURL, findReference, validateTransfer } from "@solana/pay";
import BigNumber from "bignumber.js";
import dotenv from "dotenv";

dotenv.config();

const app = express();

// ✅ CORS: permite Live Server y localhost
app.use(
  cors({
    origin: ["http://127.0.0.1:5500", "http://localhost:5500"],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);
app.use(express.json());

// ⚙️ Config
const CLUSTER = process.env.SOLANA_CLUSTER || "mainnet-beta";
const MERCHANT_WALLET = (process.env.MERCHANT_WALLET || "").trim();
if (!MERCHANT_WALLET) throw new Error("❌ Falta MERCHANT_WALLET en .env");

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

    if (amount === undefined || amount === null || isNaN(Number(amount))) {
      return res.status(400).json({ error: "Monto inválido" });
    }

    const chosenToken = token === "SOL" ? "SOL" : "USDC";
    // Normaliza decimales según token (SOL=5, USDC=3)
    if (chosenToken === "SOL") {
      amount = parseFloat(amount).toFixed(5);
    } else {
      amount = parseFloat(amount).toFixed(3);
    }

    const usdcMint = USDC_MINTS[CLUSTER];

    // Referencia aleatoria
    const reference = Keypair.generate().publicKey;

    // BigNumber
    const amountBN = toBN(amount);

    // URL Solana Pay
    const url = encodeURL({
      recipient: new PublicKey(MERCHANT_WALLET),
      amount: amountBN,
      splToken: chosenToken === "USDC" ? new PublicKey(usdcMint) : undefined,
      label: restaurant || "Restaurante Lisboa",
      message: `Pago en ${chosenToken}`,
      reference,
    });

    // Guardar registro
    global.payments[reference.toBase58()] = {
      amount: amountBN.toString(),
      token: chosenToken,
      status: "pendiente",
      created: new Date().toISOString(),
    };

    console.log(
      `[${CLUSTER}] 💰 Nuevo pago: ${amountBN.toString()} ${chosenToken} → ${
        restaurant || "Restaurante Lisboa"
      }`
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
    res
      .status(500)
      .json({ error: "Error generando el pago", details: err.message });
  }
});

/**
 * GET /confirm/:reference
 * Verifica si el pago fue confirmado on-chain
 */
app.get("/confirm/:reference", async (req, res) => {
  const { reference } = req.params;
  const payment = global.payments[reference];

  if (!payment)
    return res.status(404).json({ error: "Referencia no encontrada" });

  try {
    const referenceKey = new PublicKey(reference);
    const sigInfo = await findReference(connection, referenceKey, {
      finality: "confirmed",
    });

    if (!sigInfo?.signature) {
      return res.json({ status: "pendiente" });
    }

    await validateTransfer(connection, {
      recipient: new PublicKey(MERCHANT_WALLET),
      amount: toBN(payment.amount),
      reference: referenceKey,
      splToken:
        payment.token === "USDC"
          ? new PublicKey(USDC_MINTS[CLUSTER])
          : undefined,
    });

    payment.status = "pagado";
    payment.signature = sigInfo.signature;

    console.log(`✅ Pago confirmado (${payment.token}): ${payment.amount}`);
    res.json({ status: "pagado", signature: sigInfo.signature });
  } catch (err) {
    if (err.message?.includes("not found")) {
      res.json({ status: "pendiente" });
    } else {
      console.error("Error verificando pago:", err);
      res
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
