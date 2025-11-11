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

// === Guardar historial en disco ===
function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(global.payments, null, 2));
  } catch (e) {
    console.error("No se pudo guardar historial:", e.message);
  }
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
      "https://raypay-backend.onrender.com",
    ],
    methods: ["GET", "POST", "OPTIONS"],
    optionsSuccessStatus: 204,
  })
);
app.use(express.json());

// === Configuración base ===
const CLUSTER = process.env.SOLANA_CLUSTER || "mainnet-beta";
const MERCHANT_WALLET = (process.env.MERCHANT_WALLET || "").trim();
if (!MERCHANT_WALLET) throw new Error("❌ Falta MERCHANT_WALLET en archivo .env");

const USDC_MINTS = {
  "mainnet-beta": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  devnet: "Gh9ZwEmdLJ8DscKNTkTqPBjAn6AoKkYzkvTzJk1io4k",
};

// 🔥 RPC con configuración optimizada
const RPC_URL = process.env.RPC_URL || clusterApiUrl(CLUSTER);
const connection = new Connection(RPC_URL, {
  commitment: "confirmed",
  // ⚡ Configuración para reducir llamadas
  httpHeaders: {
    "Content-Type": "application/json",
  },
});

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

// ============================================
// 🔹 RUTAS
// ============================================

app.get("/", (_req, res) => {
  res.send("✅ RayPay backend activo y operativo.");
});

app.get("/__health", (_req, res) => {
  res.json({
    ok: true,
    cluster: CLUSTER,
    merchant: MERCHANT_WALLET,
    now: new Date().toISOString(),
  });
});

app.get("/routes", (_req, res) => {
  const routes = [];
  app._router.stack.forEach((m) => {
    if (m.route && m.route.path) {
      routes.push({ 
        method: Object.keys(m.route.methods)[0].toUpperCase(), 
        path: m.route.path 
      });
    }
  });
  res.json({ routes });
});

// === Crear pago (QR) ===
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
      const postToken = tx.meta.postTokenBalances?.find((b) => b.owner === merchant);
      const preToken = tx.meta.preTokenBalances?.find((b) => b.owner === merchant);
      const postAmount = postToken?.uiTokenAmount?.uiAmount ?? 0;
      const preAmount = preToken?.uiTokenAmount?.uiAmount ?? 0;
      received = postAmount - preAmount;
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

// === Historial (archivo local) ===
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

// === REBUILD HISTORY (desactivado por defecto para evitar 429) ===
app.get("/rebuild-history", async (req, res) => {
  // ⚠️ Esta ruta hace MUCHAS llamadas al RPC
  // Solo úsala si tienes un RPC premium (Helius/QuickNode pagado)
  res.status(503).json({ 
    error: "Endpoint desactivado temporalmente",
    reason: "Causa muchos errores 429 en RPC gratuito",
    suggestion: "Usa /wallet-history con limit bajo o migra a base de datos"
  });
});

// === WALLET HISTORY (optimizado y con límite bajo) ===
app.get("/wallet-history", async (req, res) => {
  try {
    const merchant = new PublicKey(MERCHANT_WALLET);
    // 🎯 Límite MUY bajo para evitar 429
    const limit = Math.min(parseInt(req.query.limit || "15", 10), 30);
    const usdcMint = USDC_MINTS[CLUSTER];

    console.log(`⏳ Consultando últimas ${limit} transacciones...`);

    // 1️⃣ Obtener firmas (1 llamada)
    const sigs = await connection.getSignaturesForAddress(merchant, { limit });
    if (!sigs.length) return res.json({ data: [], meta: { note: "sin-firmas" } });

    // 2️⃣ Procesar en lotes pequeños de 10 (en vez de 20)
    const chunks = [];
    for (let i = 0; i < sigs.length; i += 10) {
      chunks.push(sigs.slice(i, i + 10).map(s => s.signature));
    }

    const rows = [];
    for (const [index, batch] of chunks.entries()) {
      console.log(`📦 Procesando lote ${index + 1}/${chunks.length}...`);
      
      // ⏱️ Pequeña pausa entre lotes para no saturar el RPC
      if (index > 0) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      const txs = await connection.getParsedTransactions(batch, { 
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0 
      });

      for (const tx of txs || []) {
        if (!tx?.meta) continue;

        const keys = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
        const idx = keys.indexOf(merchant.toBase58());

        // SOL recibido
        let solReceived = 0;
        if (idx >= 0 && tx.meta.preBalances && tx.meta.postBalances) {
          solReceived = (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / 1e9;
        }

        // USDC recibido
        const preT = tx.meta.preTokenBalances?.find(b => b.owner === merchant.toBase58() && b.mint === usdcMint);
        const postT = tx.meta.postTokenBalances?.find(b => b.owner === merchant.toBase58() && b.mint === usdcMint);
        const preAmt = preT?.uiTokenAmount?.uiAmount ?? 0;
        const postAmt = postT?.uiTokenAmount?.uiAmount ?? 0;
        const usdcReceived = postAmt - preAmt;

        const ms = (tx.blockTime ? tx.blockTime * 1000 : Date.now());
        const sig = tx.transaction.signatures?.[0];

        if (usdcReceived > 0) {
          rows.push({ 
            txHash: sig, 
            amount: Number(usdcReceived.toFixed(6)), 
            token: "USDC", 
            blockTime: ms 
          });
        } else if (solReceived > 0) {
          rows.push({ 
            txHash: sig, 
            amount: Number(solReceived.toFixed(9)), 
            token: "SOL", 
            blockTime: ms 
          });
        }
      }
    }

    console.log(`✅ Encontradas ${rows.length} transacciones`);
    return res.json({ data: rows, meta: { processed: limit } });

  } catch (err) {
    // Manejo especial de 429
    if (String(err?.message || "").includes("Too Many Requests") || 
        String(err?.message || "").includes("429")) {
      console.warn("⚠️ Rate-limited por el RPC. Devuelvo data vacía.");
      return res.json({ 
        data: [], 
        meta: { 
          warning: "rate_limited_rpc",
          suggestion: "Reduce el límite o usa un RPC premium"
        } 
      });
    }
    
    console.error("Error en /wallet-history:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================
// 🚀 INICIAR SERVIDOR
// ============================================
app.listen(PORT, () => {
  console.log(`✅ Servidor RayPay activo en http://localhost:${PORT} [${CLUSTER}]`);
  console.log(`📍 Rutas: /, /create-payment, /confirm/:ref, /history, /wallet-history`);
  console.log(`⚠️ /rebuild-history desactivado (causa errores 429)`);
});