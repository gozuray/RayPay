import express from "express";
import cors from "cors";
import { PublicKey, Connection, clusterApiUrl, Keypair } from "@solana/web3.js";
import { encodeURL, findReference } from "@solana/pay";
import BigNumber from "bignumber.js";
import dotenv from "dotenv";
import fs from "fs";
const HISTORY_FILE = "./payments-history.json";

function saveHistory() {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(global.payments, null, 2));
}

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
// 🔁 Cargar historial guardado si existe
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
  global.payments = {};
}


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
  payment.confirmedAt = new Date().toISOString();
  payment.txHash = sigInfo.signature;
  payment.summary = {
    token: payment.token,
    amount: payment.amount,
    date: new Date().toLocaleDateString(),
    time: new Date().toLocaleTimeString(),
  };

  saveHistory(); // ✅ Guardar después de actualizar los datos

  console.log(`✅ Pago confirmado (${payment.token}): ${received}`);
  return res.json({ status: "pagado", signature: sigInfo.signature });
}
 else {
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

// Descarga CSV
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
    list
      .map((r) =>
        Object.values(r)
          .map((v) => `"${v ?? ""}"`)
          .join(",")
      )
      .join("\n");

  res.header("Content-Type", "text/csv");
  res.attachment("historial.csv");
  res.send(csv);
});
// 🚀 Servidor
const PORT = process.env.PORT || 3000;
/**
 * GET /wallet-history
 * Query params:
 *  - limit (opcional, default 100) -> cantidad de firmas a recuperar por página
 *  - before (opcional) -> signature para paginar (usar como cursor)
 *
 * Retorna lista de transacciones parseadas relacionadas con MERCHANT_WALLET.
 */
app.get("/wallet-history", async (req, res) => {
  try {
    const limit = Math.min(1000, parseInt(req.query.limit || "200", 10)); // máximo 1000
    const before = req.query.before || undefined;
    const merchantPubkey = new PublicKey(MERCHANT_WALLET);

    // 1) Obtener firmas (signatures) para la dirección (paginar con `before`)
    const sigInfos = await connection.getSignaturesForAddress(merchantPubkey, {
      limit,
      before,
    });

    if (!sigInfos || sigInfos.length === 0) {
      return res.json({ data: [], nextCursor: null });
    }

    // 2) Pedir las transacciones parseadas en batch
    const signatures = sigInfos.map((s) => s.signature);
    const parsedTxsPromises = signatures.map((sig) =>
      connection.getParsedTransaction(sig, { commitment: "confirmed" })
    );

    const parsedTxs = await Promise.all(parsedTxsPromises);

    // 3) Extraer información relevante
    const results = parsedTxs.map((tx, idx) => {
      const sig = signatures[idx];
      if (!tx) {
        return {
          txHash: sig,
          slot: sigInfos[idx].slot,
          status: "unknown",
        };
      }

      const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null;
      const slot = tx.slot;
      const meta = tx.meta || {};
      const status = meta.err ? "failed" : "confirmed";

      // Intentamos extraer transferencias (SOL y SPL) que afecten al merchant
      let amount = null;
      let token = null;

      // 3a) Buscar en pre/post balances (SOL transfers)
      try {
        const keys = tx.transaction.message.accountKeys.map((k) => ({
          pubkey: k.pubkey.toBase58(),
          signer: k.signer,
          writable: k.writable,
        }));

        // Revisa cambios en sol balances
        if (meta.preBalances && meta.postBalances) {
          const pre = meta.preBalances;
          const post = meta.postBalances;
          for (let i = 0; i < keys.length; i++) {
            if (keys[i].pubkey === MERCHANT_WALLET) {
              const diff = post[i] - pre[i];
              if (diff > 0) {
                amount = diff / 1e9; // lamports -> SOL
                token = "SOL";
              }
            }
          }
        }

        // 3b) Buscar en postTokenBalances (SPL token transfers)
        if (!amount && meta.postTokenBalances && meta.preTokenBalances) {
          // compara balances por owner
          const postToken = meta.postTokenBalances.find((b) => b.owner === MERCHANT_WALLET);
          const preToken = meta.preTokenBalances.find((b) => b.owner === MERCHANT_WALLET);
          if (postToken) {
            const postAmt = parseFloat(postToken.uiTokenAmount.uiAmountString || 0);
            const preAmt = preToken ? parseFloat(preToken.uiTokenAmount.uiAmountString || 0) : 0;
            const diff = postAmt - preAmt;
            if (diff !== 0) {
              amount = diff;
              token = postToken.mint || "SPL";
            }
          }
        }
      } catch (e) {
        // no bloquear por parsing
      }

      return {
        txHash: sig,
        slot,
        blockTime,
        status,
        amount,
        token,
        // devolvemos el parsed tx para debugging si quieres
        short: {
          fee: meta.fee,
          err: meta.err,
          logMessages: meta.logMessages ? meta.logMessages.slice(0, 5) : undefined,
        },
      };
    });

    // 4) nextCursor: la última firma para paginar (si quieres la siguiente página, envía before=nextCursor)
    const nextCursor = sigInfos.length > 0 ? sigInfos[sigInfos.length - 1].signature : null;

    res.json({ data: results, nextCursor });
  } catch (err) {
    console.error("Error en /wallet-history:", err);
    res.status(500).json({ error: "Error obteniendo historial de la wallet", details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Servidor en http://localhost:${PORT} [${CLUSTER}]`);
});
