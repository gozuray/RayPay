import express from "express";
import cors from "cors";
import { PublicKey, Connection, clusterApiUrl, Keypair } from "@solana/web3.js";
import { encodeURL, findReference } from "@solana/pay";
import BigNumber from "bignumber.js";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const app = express();
const HISTORY_FILE = "./payments-history.json";
const PORT = process.env.PORT || 3000;

// === Función para guardar historial ===
function saveHistory() {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(global.payments, null, 2));
}

// === CORS ===
app.use(
  cors({
    origin: [
      "http://127.0.0.1:5500",
      "http://localhost:5500",
      "http://127.0.0.1:3000",
      "http://localhost:3000",
      "https://raypay-1.onrender.com",
      "https://raypaybackend.onrender.com", // ✅ tu dominio Render
    ],
    methods: ["GET", "POST", "OPTIONS"],
    optionsSuccessStatus: 204,
  })
);
app.use(express.json());

// === Prueba de conexión ===
app.get("/", (_req, res) => {
  res.send("✅ RayPay backend activo y operativo.");
});

// === Configuración base ===
const CLUSTER = process.env.SOLANA_CLUSTER || "mainnet-beta";
const MERCHANT_WALLET = (process.env.MERCHANT_WALLET || "").trim();
if (!MERCHANT_WALLET)
  throw new Error("❌ Falta MERCHANT_WALLET en archivo .env");

const USDC_MINTS = {
  "mainnet-beta": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  devnet: "Gh9ZwEmdLJ8DscKNTkTqPBjAn6AoKkYzkvTzJk1io4k",
};

const connection = new Connection(clusterApiUrl(CLUSTER));
const toBN = (v) => new BigNumber(String(v));

// === Cargar historial guardado ===
global.payments = {};
try {
  if (fs.existsSync(HISTORY_FILE)) {
    const data = fs.readFileSync(HISTORY_FILE, "utf8");
    global.payments = JSON.parse(data);
    console.log(`📂 Historial cargado: ${Object.keys(global.payments).length} registros`);
  } else {
    console.log("ℹ️ No hay historial previo, iniciando nuevo archivo.");
  }
} catch (err) {
  console.error("⚠️ Error al leer historial:", err);
}

// === Crear pago ===
app.post("/create-payment", (req, res) => {
  try {
    let { amount, restaurant, token } = req.body;
    if (amount === undefined || isNaN(Number(amount))) {
      return res.status(400).json({ error: "Monto inválido" });
    }

    const chosenToken = token === "SOL" ? "SOL" : "USDC";
    amount = parseFloat(amount).toFixed(chosenToken === "SOL" ? 5 : 3);

    const usdcMint = USDC_MINTS[CLUSTER];
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

    res.json({
      success: true,
      solana_url: url.toString(),
      token: chosenToken,
      cluster: CLUSTER,
      reference: reference.toBase58(),
    });

    console.log(`[${CLUSTER}] 💰 Nuevo pago ${amountBN.toString()} ${chosenToken}`);
  } catch (err) {
    console.error("Error en /create-payment:", err);
    res.status(500).json({ error: err.message });
  }
});

// === Confirmar pago ===
app.get("/confirm/:reference", async (req, res) => {
  const { reference } = req.params;
  const payment = global.payments[reference];
  if (!payment) return res.status(404).json({ error: "Referencia no encontrada" });

  try {
    const referenceKey = new PublicKey(reference);
    const sigInfo = await findReference(connection, referenceKey, { finality: "confirmed" });

    if (!sigInfo?.signature) return res.json({ status: "pendiente" });

    const tx = await connection.getParsedTransaction(sigInfo.signature, { commitment: "confirmed" });
    if (!tx?.meta) return res.json({ status: "pendiente" });

    const merchant = MERCHANT_WALLET;
    const expectedAmount = parseFloat(payment.amount);
    let received = 0;

    if (payment.token === "SOL") {
      const pre = tx.meta.preBalances;
      const post = tx.meta.postBalances;
      const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
      const index = keys.indexOf(merchant);
      if (index >= 0) received = (post[index] - pre[index]) / 1e9;
    } else {
      const postToken = tx.meta.postTokenBalances.find((b) => b.owner === merchant);
      if (postToken) received = parseFloat(postToken.uiTokenAmount.uiAmountString);
    }

    if (received >= expectedAmount - 0.00001) {
      payment.status = "pagado";
      payment.signature = sigInfo.signature;
      payment.txHash = sigInfo.signature;
      payment.confirmedAt = new Date().toISOString();
      payment.summary = {
        token: payment.token,
        amount: payment.amount,
        date: new Date().toLocaleDateString(),
        time: new Date().toLocaleTimeString(),
      };
      saveHistory();
      console.log(`✅ Pago confirmado: ${payment.amount} ${payment.token}`);
      return res.json({ status: "pagado", signature: sigInfo.signature });
    } else {
      return res.json({ status: "pendiente" });
    }
  } catch (err) {
    if (err.message?.includes("not found")) return res.json({ status: "pendiente" });
    console.error("Error verificando pago:", err);
    res.status(500).json({ error: err.message });
  }
});

// === Historial simple ===
app.get("/history", (req, res) => {
  const list = Object.entries(global.payments).map(([ref, p]) => ({
    reference: ref,
    status: p.status,
    amount: p.amount,
    token: p.token,
    date: p.summary?.date,
    time: p.summary?.time,
    txHash: p.txHash,
  }));
  res.json(list);
});

// === Descargar CSV ===
app.get("/history/download", (req, res) => {
  const list = Object.entries(global.payments).map(([ref, p]) => ({
    Reference: ref,
    Estado: p.status,
    Token: p.token,
    Monto: p.amount,
    Fecha: p.summary?.date,
    Hora: p.summary?.time,
    TxHash: p.txHash,
  }));

  const csv =
    "Reference,Estado,Token,Monto,Fecha,Hora,TxHash\n" +
    list.map((r) => Object.values(r).map((v) => `"${v ?? ""}"`).join(",")).join("\n");

  res.header("Content-Type", "text/csv");
  res.attachment("historial.csv");
  res.send(csv);
});

// === Reconstruir historial desde la blockchain ===
app.get("/rebuild-history", async (req, res) => {
  try {
    const merchant = new PublicKey(MERCHANT_WALLET);
    const sigs = await connection.getSignaturesForAddress(merchant, { limit: 1000 });
    const confirmed = [];

    for (const s of sigs) {
      const tx = await connection.getParsedTransaction(s.signature, { commitment: "confirmed" });
      if (!tx?.meta) continue;

      const instructionRefs = [];
      for (const ix of tx.transaction.message.instructions) {
        if (ix.accounts?.length) {
          for (const acc of ix.accounts) {
            const keyIndex = acc;
            const key = tx.transaction.message.accountKeys[keyIndex];
            if (key?.pubkey) instructionRefs.push(key.pubkey.toBase58());
          }
        }
      }

      for (const ref of Object.keys(global.payments)) {
        if (instructionRefs.includes(ref)) {
          const amount = global.payments[ref]?.amount || null;
          const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000) : new Date();

          confirmed.push({
            reference: ref,
            signature: s.signature,
            amount,
            token: global.payments[ref]?.token || "USDC",
            date: blockTime.toLocaleDateString(),
            time: blockTime.toLocaleTimeString(),
            status: "pagado",
          });
        }
      }
    }

    // ✅ Actualizar archivo local si se desea
    saveHistory();

    console.log(`✅ ${confirmed.length} transacciones confirmadas reconstruidas`);
    res.json({ total: confirmed.length, data: confirmed });
  } catch (err) {
    console.error("Error reconstruyendo historial:", err);
    res.status(500).json({ error: err.message });
  }
});

// === Iniciar servidor ===
app.listen(PORT, () => {
  console.log(`✅ Servidor RayPay activo en http://localhost:${PORT} [${CLUSTER}]`);
});
