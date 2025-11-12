import express from "express";
import cors from "cors";
import { PublicKey, Connection, clusterApiUrl, Keypair } from "@solana/web3.js";
import { encodeURL, findReference } from "@solana/pay";
import BigNumber from "bignumber.js";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion } from "mongodb";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// 🔹 CONFIGURACIÓN MONGODB
// ============================================
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  throw new Error("❌ Falta MONGODB_URI en .env");
}

const mongoClient = new MongoClient(MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

let db;
let paymentsCollection;

// Conectar a MongoDB
async function connectMongo() {
  try {
    await mongoClient.connect();
    await mongoClient.db("admin").command({ ping: 1 });
    console.log("✅ Conectado a MongoDB Atlas");
    
    db = mongoClient.db("raypay");
    paymentsCollection = db.collection("payments");
    
    // Crear índices para búsquedas eficientes
    await paymentsCollection.createIndex({ signature: 1 }, { unique: true });
    await paymentsCollection.createIndex({ blockTime: -1 });
    await paymentsCollection.createIndex({ token: 1 });
    await paymentsCollection.createIndex({ merchantWallet: 1 });
    
    console.log("✅ Base de datos 'raypay' lista");
  } catch (err) {
    console.error("❌ Error conectando a MongoDB:", err);
    process.exit(1);
  }
}

// ============================================
// 🔹 CONFIGURACIÓN SOLANA
// ============================================
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

const CLUSTER = process.env.SOLANA_CLUSTER || "mainnet-beta";
const MERCHANT_WALLET = (process.env.MERCHANT_WALLET || "").trim();
if (!MERCHANT_WALLET) throw new Error("❌ Falta MERCHANT_WALLET en .env");

const USDC_MINTS = {
  "mainnet-beta": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  devnet: "Gh9ZwEmdLJ8DscKNTkTqPBjAn6AoKkYzkvTzJk1io4k",
};

const RPC_URL = process.env.RPC_URL || clusterApiUrl(CLUSTER);
const connection = new Connection(RPC_URL, {
  commitment: "confirmed",
  confirmTransactionInitialTimeout: 60000
});

console.log(`🌐 Cluster: ${CLUSTER}`);
console.log(`🌐 RPC: ${RPC_URL}`);
console.log(`💼 Merchant: ${MERCHANT_WALLET}`);

const toBN = (v) => new BigNumber(String(v));

// Cache temporal para pagos pendientes
global.pendingPayments = {};

// ============================================
// 🔹 RUTAS
// ============================================

app.get("/", (_req, res) => {
  res.send("✅ RayPay Backend - MongoDB Cloud Edition");
});

app.get("/__health", (_req, res) => {
  res.json({
    ok: true,
    cluster: CLUSTER,
    merchant: MERCHANT_WALLET,
    mongodb: mongoClient.topology?.isConnected() ? "connected" : "disconnected",
    now: new Date().toISOString(),
  });
});

// ============================================
// 🔹 CREAR PAGO (QR)
// ============================================
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
      restaurant: restaurant || "Restaurante Lisboa",
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

// ============================================
// 🔹 CONFIRMAR PAGO Y GUARDAR EN MONGODB
// ============================================
app.get("/confirm/:reference", async (req, res) => {
  const { reference } = req.params;
  const payment = global.pendingPayments[reference];
  
  if (!payment) {
    return res.status(404).json({ error: "Referencia no encontrada" });
  }

  try {
    // 1. Verificar si ya existe en la BD
    const existing = await paymentsCollection.findOne({ reference });
    if (existing) {
      return res.json({ 
        status: "pagado", 
        signature: existing.signature,
        fromCache: true 
      });
    }

    // 2. Buscar en la blockchain
    const referenceKey = new PublicKey(reference);
    const sigInfo = await findReference(connection, referenceKey, { 
      finality: "confirmed" 
    });

    if (!sigInfo?.signature) {
      return res.json({ status: "pendiente" });
    }

    // 3. Obtener detalles de la transacción
    const tx = await connection.getParsedTransaction(sigInfo.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0
    });

    if (!tx?.meta) {
      return res.json({ status: "pendiente" });
    }

    const merchant = MERCHANT_WALLET;
    const expectedAmount = parseFloat(payment.amount);
    let received = 0;

    // Calcular monto recibido
    if (payment.token === "SOL") {
      const pre = tx.meta.preBalances;
      const post = tx.meta.postBalances;
      const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
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

    // 4. Verificar si el pago es válido
    if (received >= expectedAmount - 0.00001) {
      const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
      const payer = keys[0] || "desconocido";
      const blockTime = tx.blockTime ? tx.blockTime * 1000 : Date.now();

      // 5. Guardar en MongoDB
      const paymentDoc = {
        signature: sigInfo.signature,
        reference: reference,
        token: payment.token,
        amount: Number(received.toFixed(payment.token === "SOL" ? 9 : 6)),
        expectedAmount: expectedAmount,
        merchantWallet: merchant,
        payer: payer,
        fee: tx.meta.fee / 1e9,
        slot: tx.slot || 0,
        blockTime: blockTime,
        date: new Date(blockTime).toLocaleDateString("es-ES"),
        time: new Date(blockTime).toLocaleTimeString("es-ES"),
        status: "success",
        restaurant: payment.restaurant || "Restaurante Lisboa",
        cluster: CLUSTER,
        createdAt: new Date(),
      };

      try {
        await paymentsCollection.insertOne(paymentDoc);
        console.log(`✅ Pago guardado en MongoDB: ${sigInfo.signature.slice(0, 8)}...`);
      } catch (dbErr) {
        // Si falla por duplicado, no es problema
        if (dbErr.code !== 11000) {
          console.error("Error guardando en MongoDB:", dbErr);
        }
      }

      // Limpiar cache
      delete global.pendingPayments[reference];

      return res.json({ 
        status: "pagado", 
        signature: sigInfo.signature,
        amount: received,
        savedToDatabase: true
      });
    } else {
      return res.json({ status: "pendiente" });
    }
  } catch (err) {
    if (err.message?.includes("not found")) {
      return res.json({ status: "pendiente" });
    }
    console.error("Error verificando pago:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// 🔹 OBTENER HISTORIAL DESDE MONGODB
// ============================================
app.get("/transactions", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
    const filterToken = req.query.token?.toUpperCase();
    const skip = parseInt(req.query.skip || "0", 10);

    // Construir filtro
    const filter = { merchantWallet: MERCHANT_WALLET };
    if (filterToken && (filterToken === "SOL" || filterToken === "USDC")) {
      filter.token = filterToken;
    }

    console.log(`📊 Obteniendo transacciones desde MongoDB...`);

    // Obtener transacciones
    const transactions = await paymentsCollection
      .find(filter)
      .sort({ blockTime: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    // Obtener totales
    const totalCount = await paymentsCollection.countDocuments(filter);

    // Calcular estadísticas
    const stats = await paymentsCollection.aggregate([
      { $match: filter },
      {
        $group: {
          _id: "$token",
          total: { $sum: "$amount" },
          count: { $sum: 1 }
        }
      }
    ]).toArray();

    const totals = {
      SOL: stats.find(s => s._id === "SOL")?.total || 0,
      USDC: stats.find(s => s._id === "USDC")?.total || 0,
    };

    console.log(`✅ ${transactions.length} transacciones obtenidas de MongoDB`);

    return res.json({
      data: transactions.map(tx => ({
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
      total: totalCount,
      returned: transactions.length,
      filtered: filterToken ? true : false,
      filterToken: filterToken || "all",
      totals: totals,
    });
  } catch (err) {
    console.error("❌ Error en /transactions:", err);
    return res.status(500).json({
      error: err.message,
      data: [],
      total: 0,
    });
  }
});

// ============================================
// 🔹 DESCARGAR CSV
// ============================================
app.get("/transactions/download", async (req, res) => {
  try {
    const filterToken = req.query.token?.toUpperCase();
    const filter = { merchantWallet: MERCHANT_WALLET };
    if (filterToken && (filterToken === "SOL" || filterToken === "USDC")) {
      filter.token = filterToken;
    }

    const transactions = await paymentsCollection
      .find(filter)
      .sort({ blockTime: -1 })
      .limit(500)
      .toArray();

    if (transactions.length === 0) {
      return res.status(404).send("No hay transacciones para descargar");
    }

    const csv =
      "Signature,Token,Monto,Pagador,Fee,Slot,Fecha,Hora,Estado,Restaurante\n" +
      transactions
        .map((tx) =>
          `"${tx.signature}","${tx.token}","${tx.amount}","${tx.payer}","${tx.fee}","${tx.slot}","${tx.date}","${tx.time}","${tx.status}","${tx.restaurant || "N/A"}"`
        )
        .join("\n");

    res.header("Content-Type", "text/csv; charset=utf-8");
    res.attachment(`transacciones_${new Date().toISOString().split("T")[0]}.csv`);
    res.send(csv);
  } catch (err) {
    console.error("Error generando CSV:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// 🔹 SINCRONIZAR PAGOS DESDE BLOCKCHAIN (ADMIN)
// ============================================
app.post("/admin/sync-blockchain", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "20", 10), 50);
    const merchant = new PublicKey(MERCHANT_WALLET);
    const usdcMint = USDC_MINTS[CLUSTER];

    console.log(`🔄 Sincronizando últimas ${limit} transacciones...`);

    const signatures = await connection.getSignaturesForAddress(merchant, { limit });
    
    let syncedCount = 0;
    let skippedCount = 0;

    for (const sigInfo of signatures) {
      // Verificar si ya existe
      const exists = await paymentsCollection.findOne({ 
        signature: sigInfo.signature 
      });
      
      if (exists) {
        skippedCount++;
        continue;
      }

      // Obtener detalles
      const tx = await connection.getParsedTransaction(sigInfo.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0
      });

      if (!tx?.meta || tx.meta.err !== null) continue;

      const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
      const merchantIndex = keys.indexOf(merchant.toBase58());
      const payer = keys[0] || "desconocido";
      const blockTime = sigInfo.blockTime ? sigInfo.blockTime * 1000 : Date.now();

      // Detectar SOL
      if (merchantIndex >= 0 && tx.meta.preBalances && tx.meta.postBalances) {
        const solReceived = (tx.meta.postBalances[merchantIndex] - tx.meta.preBalances[merchantIndex]) / 1e9;
        
        if (solReceived > 0) {
          await paymentsCollection.insertOne({
            signature: sigInfo.signature,
            reference: null,
            token: "SOL",
            amount: Number(solReceived.toFixed(9)),
            merchantWallet: MERCHANT_WALLET,
            payer: payer,
            fee: tx.meta.fee / 1e9,
            slot: tx.slot || 0,
            blockTime: blockTime,
            date: new Date(blockTime).toLocaleDateString("es-ES"),
            time: new Date(blockTime).toLocaleTimeString("es-ES"),
            status: "success",
            restaurant: "Sincronizado",
            cluster: CLUSTER,
            createdAt: new Date(),
          });
          syncedCount++;
        }
      }

      // Detectar USDC
      const preToken = tx.meta.preTokenBalances?.find(
        (b) => b.owner === merchant.toBase58() && b.mint === usdcMint
      );
      const postToken = tx.meta.postTokenBalances?.find(
        (b) => b.owner === merchant.toBase58() && b.mint === usdcMint
      );

      if (preToken && postToken) {
        const usdcReceived = (postToken.uiTokenAmount?.uiAmount ?? 0) - (preToken.uiTokenAmount?.uiAmount ?? 0);

        if (usdcReceived > 0) {
          await paymentsCollection.insertOne({
            signature: sigInfo.signature,
            reference: null,
            token: "USDC",
            amount: Number(usdcReceived.toFixed(6)),
            merchantWallet: MERCHANT_WALLET,
            payer: payer,
            fee: tx.meta.fee / 1e9,
            slot: tx.slot || 0,
            blockTime: blockTime,
            date: new Date(blockTime).toLocaleDateString("es-ES"),
            time: new Date(blockTime).toLocaleTimeString("es-ES"),
            status: "success",
            restaurant: "Sincronizado",
            cluster: CLUSTER,
            createdAt: new Date(),
          });
          syncedCount++;
        }
      }

      // Pausa para evitar rate limit
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    console.log(`✅ Sincronización completa: ${syncedCount} nuevas, ${skippedCount} duplicadas`);

    return res.json({
      success: true,
      synced: syncedCount,
      skipped: skippedCount,
      total: signatures.length,
    });
  } catch (err) {
    console.error("❌ Error sincronizando:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================
// 🚀 INICIAR SERVIDOR
// ============================================
connectMongo().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ RayPay activo en puerto ${PORT} [${CLUSTER}]`);
    console.log(`💼 Merchant: ${MERCHANT_WALLET}`);
    console.log(`🗄️  MongoDB: Conectado`);
  });
});

// Manejar cierre graceful
process.on("SIGINT", async () => {
  console.log("\n🛑 Cerrando servidor...");
  await mongoClient.close();
  process.exit(0);
});