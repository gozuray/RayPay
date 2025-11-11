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

// 🔥 USAR HELIUS RPC (más rápido que el público)
const RPC_URL = process.env.RPC_URL || clusterApiUrl(CLUSTER);
const connection = new Connection(RPC_URL, { 
  commitment: "confirmed",
  confirmTransactionInitialTimeout: 60000
});

console.log(`🌐 Usando RPC: ${RPC_URL}`);

const toBN = (v) => new BigNumber(String(v));

// Cache temporal
global.pendingPayments = {};

// ============================================
// 🔹 RUTAS
// ============================================

app.get("/", (_req, res) => {
  res.send("✅ RayPay backend - Helius RPC optimizado");
});

app.get("/__health", (_req, res) => {
  res.json({
    ok: true,
    cluster: CLUSTER,
    merchant: MERCHANT_WALLET,
    rpcUrl: RPC_URL.includes("helius") ? "Helius RPC" : "Public RPC",
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

    console.log(`💰 QR generado: ${amountBN.toString()} ${chosenToken}`);
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

// === 🔥 HISTORIAL (método optimizado con Helius RPC) ===
app.get("/transactions", async (req, res) => {
  try {
    const merchant = new PublicKey(MERCHANT_WALLET);
    const limit = Math.min(parseInt(req.query.limit || "20", 10), 50);
    const filterToken = req.query.token?.toUpperCase();
    const usdcMint = USDC_MINTS[CLUSTER];

    console.log(`⏳ Obteniendo ${limit} transacciones de ${MERCHANT_WALLET.slice(0, 8)}...`);

    // 1️⃣ Obtener firmas (1 llamada)
    const signatures = await connection.getSignaturesForAddress(merchant, { 
      limit 
    });

    console.log(`📦 ${signatures.length} firmas obtenidas`);

    if (signatures.length === 0) {
      return res.json({ 
        data: [], 
        total: 0,
        message: "No hay transacciones en esta wallet"
      });
    }

    // 2️⃣ Procesar en lotes de 5 (conservador para evitar 429)
    const batchSize = 5;
    const transactions = [];
    
    for (let i = 0; i < signatures.length; i += batchSize) {
      const batch = signatures.slice(i, i + batchSize);
      const sigs = batch.map(s => s.signature);
      
      console.log(`📤 Procesando lote ${Math.floor(i/batchSize) + 1}/${Math.ceil(signatures.length/batchSize)}...`);
      
      // Pausa entre lotes (excepto el primero)
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Obtener transacciones parseadas
      const txs = await connection.getParsedTransactions(sigs, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0
      });

      // Procesar cada transacción
      for (let j = 0; j < txs.length; j++) {
        const tx = txs[j];
        if (!tx?.meta) continue;

        // Solo transacciones exitosas
        if (tx.meta.err !== null) continue;

        const sig = batch[j].signature;
        const blockTime = batch[j].blockTime ? batch[j].blockTime * 1000 : Date.now();
        
        const keys = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
        const merchantIndex = keys.indexOf(merchant.toBase58());
        
        // Wallet del pagador (primer signer)
        const payer = tx.transaction.message.accountKeys[0]?.pubkey?.toBase58() || "desconocido";
        
        // Fee
        const fee = tx.meta.fee / 1e9;

        // 💰 Detectar SOL recibido
        if (merchantIndex >= 0 && tx.meta.preBalances && tx.meta.postBalances) {
          const solReceived = (tx.meta.postBalances[merchantIndex] - tx.meta.preBalances[merchantIndex]) / 1e9;
          
          if (solReceived > 0) {
            transactions.push({
              signature: sig,
              token: "SOL",
              amount: Number(solReceived.toFixed(9)),
              payer: payer,
              fee: Number(fee.toFixed(9)),
              slot: tx.slot || 0,
              blockTime: blockTime,
              date: new Date(blockTime).toLocaleDateString('es-ES'),
              time: new Date(blockTime).toLocaleTimeString('es-ES'),
              status: "success",
            });
            console.log(`  ✅ SOL: ${solReceived.toFixed(5)}`);
          }
        }

        // 💵 Detectar USDC recibido
        const preToken = tx.meta.preTokenBalances?.find(b => 
          b.owner === merchant.toBase58() && b.mint === usdcMint
        );
        const postToken = tx.meta.postTokenBalances?.find(b => 
          b.owner === merchant.toBase58() && b.mint === usdcMint
        );
        
        if (preToken && postToken) {
          const preAmt = preToken.uiTokenAmount?.uiAmount ?? 0;
          const postAmt = postToken.uiTokenAmount?.uiAmount ?? 0;
          const usdcReceived = postAmt - preAmt;

          if (usdcReceived > 0) {
            transactions.push({
              signature: sig,
              token: "USDC",
              amount: Number(usdcReceived.toFixed(6)),
              payer: payer,
              fee: Number(fee.toFixed(9)),
              slot: tx.slot || 0,
              blockTime: blockTime,
              date: new Date(blockTime).toLocaleDateString('es-ES'),
              time: new Date(blockTime).toLocaleTimeString('es-ES'),
              status: "success",
            });
            console.log(`  ✅ USDC: ${usdcReceived.toFixed(2)}`);
          }
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

    console.log(`✅ ${filtered.length} transacciones procesadas`);

    return res.json({
      data: filtered,
      total: filtered.length,
      processed: signatures.length,
      filtered: filterToken ? true : false,
      filterToken: filterToken || "all",
    });

  } catch (err) {
    console.error("❌ Error en /transactions:", err);
    
    // Manejo de rate limit
    if (String(err?.message || "").includes("429") || 
        String(err?.message || "").includes("Too Many Requests")) {
      return res.json({
        data: [],
        total: 0,
        error: "rate_limited",
        message: "RPC temporalmente saturado. Intenta de nuevo en unos segundos.",
      });
    }

    return res.status(500).json({
      error: err.message,
      data: [],
      total: 0,
    });
  }
});

// === Descargar CSV ===
app.get("/transactions/download", async (req, res) => {
  try {
    const response = await fetch(`http://localhost:${PORT}/transactions?limit=50`);
    const data = await response.json();

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
  console.log(`✅ RayPay activo en puerto ${PORT} [${CLUSTER}]`);
  console.log(`🌐 RPC: ${RPC_URL.includes("helius") ? "Helius (optimizado)" : "Público"}`);
  console.log(`📍 Wallet: ${MERCHANT_WALLET}`);
});