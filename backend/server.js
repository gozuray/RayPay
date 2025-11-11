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

const USDC_MINTS = {
  "mainnet-beta": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  devnet: "Gh9ZwEmdLJ8DscKNTkTqPBjAn6AoKkYzkvTzJk1io4k",
};

const RPC_URL = process.env.RPC_URL || clusterApiUrl(CLUSTER);
const connection = new Connection(RPC_URL, { commitment: "confirmed" });

const toBN = (v) => new BigNumber(String(v));

// Cache temporal para pagos pendientes (solo sesión actual)
global.pendingPayments = {};

// ============================================
// 🔹 RUTAS
// ============================================

app.get("/", (_req, res) => {
  res.send("✅ RayPay backend activo - Solo blockchain");
});

app.get("/__health", (_req, res) => {
  res.json({
    ok: true,
    cluster: CLUSTER,
    merchant: MERCHANT_WALLET,
    mode: "blockchain-only",
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

    // Guardar solo en memoria temporal
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

// === 🔥 HISTORIAL MEJORADO (solo transacciones exitosas) ===
app.get("/transactions", async (req, res) => {
  try {
    const merchant = new PublicKey(MERCHANT_WALLET);
    const limit = Math.min(parseInt(req.query.limit || "30", 10), 100);
    const filterToken = req.query.token; // "SOL", "USDC" o undefined (todos)
    const usdcMint = USDC_MINTS[CLUSTER];

    console.log(`⏳ Consultando últimas ${limit} transacciones...`);

    // 1️⃣ Obtener firmas
    const sigs = await connection.getSignaturesForAddress(merchant, { limit });
    if (!sigs.length) return res.json({ data: [], total: 0 });

    // 2️⃣ Procesar en lotes pequeños
    const chunks = [];
    for (let i = 0; i < sigs.length; i += 10) {
      chunks.push(sigs.slice(i, i + 10).map(s => s.signature));
    }

    const transactions = [];
    
    for (const [index, batch] of chunks.entries()) {
      // Pausa entre lotes para evitar 429
      if (index > 0) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      const txs = await connection.getParsedTransactions(batch, { 
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0 
      });

      for (const tx of txs || []) {
        if (!tx?.meta) continue;

        // 🔥 SOLO transacciones exitosas
        if (tx.meta.err !== null) continue;

        const keys = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
        const idx = keys.indexOf(merchant.toBase58());
        
        // Identificar wallet del pagador (primera cuenta que no sea merchant)
        const payer = tx.transaction.message.accountKeys[0]?.pubkey?.toBase58() || "desconocido";

        // Fee de la transacción
        const fee = tx.meta.fee / 1e9; // Convertir lamports a SOL

        // SOL recibido
        let solReceived = 0;
        if (idx >= 0 && tx.meta.preBalances && tx.meta.postBalances) {
          solReceived = (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / 1e9;
        }

        // USDC recibido
        const preT = tx.meta.preTokenBalances?.find(b => b.owner === merchant && b.mint === usdcMint);
        const postT = tx.meta.postTokenBalances?.find(b => b.owner === merchant && b.mint === usdcMint);
        const preAmt = preT?.uiTokenAmount?.uiAmount ?? 0;
        const postAmt = postT?.uiTokenAmount?.uiAmount ?? 0;
        const usdcReceived = postAmt - preAmt;

        const blockTime = tx.blockTime ? tx.blockTime * 1000 : Date.now();
        const sig = tx.transaction.signatures?.[0];

        // Construir objeto de transacción
        let txData = null;

        if (usdcReceived > 0) {
          txData = {
            signature: sig,
            token: "USDC",
            amount: Number(usdcReceived.toFixed(6)),
            payer: payer,
            fee: Number(fee.toFixed(9)),
            slot: tx.slot,
            blockTime: blockTime,
            date: new Date(blockTime).toLocaleDateString('es-ES'),
            time: new Date(blockTime).toLocaleTimeString('es-ES'),
            status: "success",
          };
        } else if (solReceived > 0) {
          txData = {
            signature: sig,
            token: "SOL",
            amount: Number(solReceived.toFixed(9)),
            payer: payer,
            fee: Number(fee.toFixed(9)),
            slot: tx.slot,
            blockTime: blockTime,
            date: new Date(blockTime).toLocaleDateString('es-ES'),
            time: new Date(blockTime).toLocaleTimeString('es-ES'),
            status: "success",
          };
        }

        // Aplicar filtro de token si existe
        if (txData) {
          if (!filterToken || txData.token === filterToken.toUpperCase()) {
            transactions.push(txData);
          }
        }
      }
    }

    // Ordenar por fecha (más recientes primero)
    transactions.sort((a, b) => b.blockTime - a.blockTime);

    console.log(`✅ Encontradas ${transactions.length} transacciones exitosas`);
    return res.json({ 
      data: transactions, 
      total: transactions.length,
      filtered: filterToken ? true : false,
      filterToken: filterToken || "all"
    });

  } catch (err) {
    if (String(err?.message || "").includes("Too Many Requests") || 
        String(err?.message || "").includes("429")) {
      console.warn("⚠️ Rate-limited por el RPC");
      return res.json({ 
        data: [], 
        total: 0,
        error: "rate_limited",
        message: "RPC temporalmente saturado, intenta de nuevo en unos segundos"
      });
    }
    
    console.error("Error en /transactions:", err);
    return res.status(500).json({ error: err.message });
  }
});

// === Descargar CSV mejorado ===
app.get("/transactions/download", async (req, res) => {
  try {
    const limit = 50; // Límite prudente para descarga
    const result = await fetch(`http://localhost:${PORT}/transactions?limit=${limit}`);
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
  console.log(`📍 Modo: Solo blockchain (sin base de datos)`);
  console.log(`🔹 Endpoints: /create-payment, /confirm/:ref, /transactions, /transactions/download`);
});