import express from "express";
import cors from "cors";
import { PublicKey, Connection, clusterApiUrl, Keypair } from "@solana/web3.js";
import { encodeURL, findReference } from "@solana/pay";
import BigNumber from "bignumber.js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

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

// === Configuración ===
const CLUSTER = process.env.SOLANA_CLUSTER || "mainnet-beta";
const MERCHANT_WALLET = (process.env.MERCHANT_WALLET || "").trim();
if (!MERCHANT_WALLET) throw new Error("❌ Falta MERCHANT_WALLET en .env");

// 🔥 Extraer API key de Helius
const HELIUS_API_KEY = process.env.RPC_URL?.includes("helius-rpc.com")
  ? process.env.RPC_URL.split("api-key=")[1]
  : "eca95102-fe5e-40f3-aff4-37fd1361f13c"; // fallback

const USDC_MINTS = {
  "mainnet-beta": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  devnet: "Gh9ZwEmdLJ8DscKNTkTqPBjAn6AoKkYzkvTzJk1io4k",
};

const RPC_URL = process.env.RPC_URL || clusterApiUrl(CLUSTER);
const connection = new Connection(RPC_URL, { commitment: "confirmed" });

const toBN = (v) => new BigNumber(String(v));

// Cache temporal para pagos pendientes
global.pendingPayments = {};

// ============================================
// 🔹 RUTAS
// ============================================

app.get("/", (_req, res) => {
  res.send("✅ RayPay backend - Usando Helius API (sin rate limit)");
});

app.get("/__health", (_req, res) => {
  res.json({
    ok: true,
    cluster: CLUSTER,
    merchant: MERCHANT_WALLET,
    mode: "helius-api",
    hasApiKey: !!HELIUS_API_KEY,
    now: new Date().toISOString(),
  });
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

    global.pendingPayments[reference.toBase58()] = {
      amount: amountBN.toString(),
      token: chosenToken,
      created: new Date().toISOString(),
    };

    res.json({
      success: true,
      solana_url: url.toString(),
      token: chosenToken,
      cluster: CLUSTER,
      reference: reference.toBase58(),
    });

    console.log(`[${CLUSTER}] 💰 QR generado: ${amountBN.toString()} ${chosenToken}`);
  } catch (err) {
    console.error("Error en /create-payment:", err);
    res.status(500).json({ error: err.message });
  }
});

// === Confirmar pago ===
app.get("/confirm/:reference", async (req, res) => {
  const { reference } = req.params;
  const payment = global.pendingPayments[reference];
  if (!payment) return res.status(404).json({ error: "Referencia no encontrada" });

  try {
    const referenceKey = new PublicKey(reference);
    const sigInfo = await findReference(connection, referenceKey, { finality: "confirmed" });

    if (!sigInfo?.signature) return res.json({ status: "pendiente" });

    const tx = await connection.getParsedTransaction(sigInfo.signature, { 
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0 
    });
    
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

// === 🔥 HISTORIAL usando Helius API (1 sola llamada, sin rate limit) ===
app.get("/transactions", async (req, res) => {
  try {
    const merchant = MERCHANT_WALLET;
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 100);
    const filterToken = req.query.token?.toUpperCase();
    const usdcMint = USDC_MINTS[CLUSTER];

    console.log(`⏳ Consultando historial con Helius API...`);

    // 🚀 Helius Enhanced Transactions API - UNA SOLA LLAMADA
    const heliusUrl = `https://api.helius.xyz/v0/addresses/${merchant}/transactions?api-key=${HELIUS_API_KEY}&limit=${limit}`;
    
    const response = await fetch(heliusUrl);
    
    if (!response.ok) {
      throw new Error(`Helius API error: ${response.status} ${response.statusText}`);
    }

    const heliusData = await response.json();

    if (!Array.isArray(heliusData) || heliusData.length === 0) {
      return res.json({ data: [], total: 0, source: "helius-api" });
    }

    const transactions = [];

    for (const tx of heliusData) {
      // Solo transacciones exitosas
      if (tx.err !== null) continue;

      // Buscar transferencias nativas (SOL)
      const nativeTransfers = tx.nativeTransfers || [];
      for (const transfer of nativeTransfers) {
        if (transfer.toUserAccount === merchant && transfer.amount > 0) {
          transactions.push({
            signature: tx.signature,
            token: "SOL",
            amount: Number((transfer.amount / 1e9).toFixed(9)),
            payer: transfer.fromUserAccount || "desconocido",
            fee: tx.fee ? Number((tx.fee / 1e9).toFixed(9)) : 0,
            slot: tx.slot,
            blockTime: tx.timestamp ? tx.timestamp * 1000 : Date.now(),
            date: tx.timestamp ? new Date(tx.timestamp * 1000).toLocaleDateString('es-ES') : "?",
            time: tx.timestamp ? new Date(tx.timestamp * 1000).toLocaleTimeString('es-ES') : "?",
            status: "success",
          });
        }
      }

      // Buscar transferencias de tokens (USDC)
      const tokenTransfers = tx.tokenTransfers || [];
      for (const transfer of tokenTransfers) {
        if (
          transfer.toUserAccount === merchant && 
          transfer.mint === usdcMint &&
          transfer.tokenAmount > 0
        ) {
          transactions.push({
            signature: tx.signature,
            token: "USDC",
            amount: Number(transfer.tokenAmount.toFixed(6)),
            payer: transfer.fromUserAccount || "desconocido",
            fee: tx.fee ? Number((tx.fee / 1e9).toFixed(9)) : 0,
            slot: tx.slot,
            blockTime: tx.timestamp ? tx.timestamp * 1000 : Date.now(),
            date: tx.timestamp ? new Date(tx.timestamp * 1000).toLocaleDateString('es-ES') : "?",
            time: tx.timestamp ? new Date(tx.timestamp * 1000).toLocaleTimeString('es-ES') : "?",
            status: "success",
          });
        }
      }
    }

    // Filtrar por token si se especifica
    let filtered = transactions;
    if (filterToken) {
      filtered = transactions.filter(t => t.token === filterToken);
    }

    // Ordenar por fecha (más recientes primero)
    filtered.sort((a, b) => b.blockTime - a.blockTime);

    console.log(`✅ ${filtered.length} transacciones encontradas vía Helius API`);
    
    return res.json({ 
      data: filtered, 
      total: filtered.length,
      source: "helius-api",
      filtered: filterToken ? true : false,
      filterToken: filterToken || "all"
    });

  } catch (err) {
    console.error("Error en /transactions con Helius API:", err);
    
    // Si Helius falla, informar claramente
    return res.status(500).json({ 
      error: err.message,
      suggestion: "Verifica tu HELIUS_API_KEY en el archivo .env",
      data: [],
      total: 0
    });
  }
});

// === Descargar CSV ===
app.get("/transactions/download", async (req, res) => {
  try {
    const result = await fetch(`http://localhost:${PORT}/transactions?limit=100`);
    const data = await result.json();

    if (!data.data || data.data.length === 0) {
      return res.status(404).send("No hay transacciones para descargar");
    }

    const csv =
      "Signature,Token,Monto,Pagador,Fee,Slot,Fecha,Hora,Estado\n" +
      data.data.map((tx) => 
        `"${tx.signature}","${tx.token}","${tx.amount}","${tx.payer}","${tx.fee}","${tx.slot}","${tx.date}","${tx.time}","${tx.status}"`
      ).join("\n");

    res.header("Content-Type", "text/csv; charset=utf-8");
    res.attachment(`transacciones_${new Date().toISOString().split('T')[0]}.csv`);
    res.send(csv);
  } catch (err) {
    console.error("Error generando CSV:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// 🚀 INICIAR SERVIDOR
// ============================================
app.listen(PORT, () => {
  console.log(`✅ RayPay activo en http://localhost:${PORT} [${CLUSTER}]`);
  console.log(`🚀 Usando Helius API (sin límites de rate)`);
  console.log(`🔑 API Key: ${HELIUS_API_KEY ? "✅ Configurada" : "❌ Falta"}`);
  console.log(`📍 Endpoints: /create-payment, /confirm/:ref, /transactions`);
});