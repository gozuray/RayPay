// backend/routes/admin.js
import express from "express";
import bcrypt from "bcryptjs";
import { ObjectId } from "mongodb";
import {
  Keypair,
  Connection,
  clusterApiUrl,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { getDB } from "../db.js";
import { verifyToken } from "../utils/auth.js";

const router = express.Router();

const CLUSTER = process.env.SOLANA_CLUSTER || "mainnet-beta";
const RPC_URL = process.env.RPC_URL || clusterApiUrl(CLUSTER);
const connection = new Connection(RPC_URL, { commitment: "confirmed" });
const BALANCE_CACHE_TTL_MS = Number(process.env.BALANCE_CACHE_TTL_MS || 30000);
const balanceCache = new Map();

const USDC_MINTS = {
  "mainnet-beta": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  devnet: "Gh9ZwEmdLJ8DscKNTkTqPBjAn6AoKkYzkvTzJk1io4k",
};

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);
const SOL_CLAIM_FEE_BUFFER = Number(
  process.env.SOL_CLAIM_FEE_BUFFER || 5000
);

/**
 * Middleware: verifica que el token JWT sea válido
 * y que el usuario tenga role === "admin"
 */
function checkAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) {
    return res.status(401).json({ error: "Falta token" });
  }

  const token = auth.split(" ")[1];
  const data = verifyToken(token);

  if (!data || data.role !== "admin") {
    return res.status(403).json({ error: "No autorizado" });
  }

  req.admin = data;
  next();
}

function isValidPublicKey(address) {
  if (!address) return false;
  try {
    new PublicKey(address);
    return true;
  } catch (error) {
    return false;
  }
}

function isRateLimitError(error) {
  if (!error) return false;
  if (error.code === 429) return true;
  const message = error.message || "";
  return message.includes("429") || message.includes("Too Many Requests");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRpcRetry(fn, retries = 2, delay = 500) {
  try {
    return await fn();
  } catch (error) {
    if (retries > 0 && isRateLimitError(error)) {
      console.warn(
        `RPC rate limit reached, retrying in ${delay}ms (${retries} retries left)`
      );
      await wait(delay);
      return withRpcRetry(fn, retries - 1, delay * 2);
    }
    throw error;
  }
}

function readBalanceCache(walletAddress) {
  const cached = balanceCache.get(walletAddress);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > BALANCE_CACHE_TTL_MS) {
    balanceCache.delete(walletAddress);
    return null;
  }
  return cached.balances;
}

function writeBalanceCache(walletAddress, balances) {
  if (!walletAddress) return;
  balanceCache.set(walletAddress, { balances, timestamp: Date.now() });
}

function clearBalanceCache(walletAddress) {
  if (!walletAddress) return;
  balanceCache.delete(walletAddress);
}

async function getWalletBalances(walletAddress) {
  if (!walletAddress) {
    return { sol: 0, usdc: 0 };
  }

  const hasValidKey = isValidPublicKey(walletAddress);
  if (!hasValidKey) {
    console.warn("Saltando wallet inválida al consultar balances", walletAddress);
    return { sol: 0, usdc: 0 };
  }

  const cached = readBalanceCache(walletAddress);
  if (cached) {
    return cached;
  }

  try {
    const ownerPk = new PublicKey(walletAddress);
    const [solLamports, usdcBalance] = await Promise.all([
      withRpcRetry(() => connection.getBalance(ownerPk)).catch((error) => {
        console.error("getBalance error", error?.message || error);
        return 0;
      }),
      getUsdcBalance(ownerPk).catch(() => 0),
    ]);

    const balances = {
      sol: Number(solLamports) / LAMPORTS_PER_SOL,
      usdc: usdcBalance,
    };
    writeBalanceCache(walletAddress, balances);
    return balances;
  } catch (error) {
    console.error("getWalletBalances error", error);
    return { sol: 0, usdc: 0 };
  }
}

async function getUsdcBalance(ownerPk) {
  const mintAddress = USDC_MINTS[CLUSTER];
  if (!mintAddress) return 0;

  try {
    const mintPk = new PublicKey(mintAddress);
    const response = await withRpcRetry(() =>
      connection.getParsedTokenAccountsByOwner(ownerPk, {
        mint: mintPk,
      })
    );

    const tokenInfo =
      response.value?.[0]?.account?.data?.parsed?.info?.tokenAmount;
    return Number(tokenInfo?.uiAmount ?? 0);
  } catch (error) {
    if (isRateLimitError(error)) {
      console.warn("getUsdcBalance rate limited, devolviendo último valor en cache");
    } else {
      console.error("getUsdcBalance error", error);
    }
    return 0;
  }
}

function getAssociatedTokenAddress(mint, owner) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

function createAssociatedTokenAccountInstruction(
  payer,
  associatedToken,
  owner,
  mint
) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedToken, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });
}

function createTokenTransferInstruction(source, destination, owner, amount) {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0); // Transfer instruction
  data.writeBigUInt64LE(BigInt(amount), 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_PROGRAM_ID,
    data,
  });
}

/**
 * GET /admin/merchants
 */
router.get("/merchants", checkAdmin, async (req, res) => {
  try {
    const db = getDB();
    const merchants = await db
      .collection("merchants")
      .find({})
      .project({ password: 0 })
      .toArray();

    const enriched = await Promise.all(
      merchants.map(async (merchant) => {
        const balances = await getWalletBalances(merchant.wallet);
        return {
          ...merchant,
          balances,
          destinationWallet: merchant.destinationWallet || "",
        };
      })
    );

    res.json({ merchants: enriched });
  } catch (e) {
    console.error("admin /merchants:", e);
    res.status(500).json({ error: "Error al listar merchants" });
  }
});

/**
 * POST /admin/create
 * body: { username, wallet?, walletMode?, password }
 */
router.post("/create", checkAdmin, async (req, res) => {
  try {
    const { username, wallet, password, walletMode, destinationWallet } =
      req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: "Usuario y contraseña son obligatorios" });
    }

    const normalizedWalletMode = walletMode === "auto" ? "auto" : "manual";

    if (normalizedWalletMode === "manual" && !wallet) {
      return res.status(400).json({ error: "Debes indicar una wallet para el modo manual" });
    }

    if (wallet && !isValidPublicKey(wallet)) {
      return res.status(400).json({ error: "Wallet manual inválida" });
    }

    if (destinationWallet && !isValidPublicKey(destinationWallet)) {
      return res.status(400).json({ error: "Wallet de destino inválida" });
    }

    const db = getDB();
    const merchants = db.collection("merchants");

    const existing = await merchants.findOne({ username });
    if (existing) {
      return res.status(400).json({ error: "Ese usuario ya existe" });
    }

    const hashed = await bcrypt.hash(password, 10);

    let walletAddress = wallet?.trim();
    let privateKeyBase64 = null;

    if (normalizedWalletMode === "auto") {
      const keypair = Keypair.generate();
      walletAddress = keypair.publicKey.toBase58();
      privateKeyBase64 = Buffer.from(keypair.secretKey).toString("base64");
    }

    const insertResult = await merchants.insertOne({
      username,
      wallet: walletAddress,
      destinationWallet: destinationWallet?.trim() || "",
      password: hashed,
      role: "merchant",
    });

    if (privateKeyBase64) {
      await db.collection("privateKeys").insertOne({
        merchantId: insertResult.insertedId,
        merchantUsername: username,
        walletAddress,
        privateKey: privateKeyBase64,
        createdAt: new Date(),
        mode: normalizedWalletMode,
      });
    }

    res.json({
      success: true,
      merchant: {
        id: insertResult.insertedId.toString(),
        username,
        wallet: walletAddress,
        destinationWallet: destinationWallet?.trim() || "",
      },
      wallet: privateKeyBase64
        ? {
            address: walletAddress,
            privateKey: privateKeyBase64,
          }
        : null,
    });
  } catch (e) {
    console.error("admin /create:", e);
    res.status(500).json({ error: "Error al crear merchant" });
  }
});

/**
 * PUT /admin/merchant/:id
 * body: { username?, wallet?, password? }
 */
router.put("/merchant/:id", checkAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { username, wallet, password } = req.body || {};

    const update = {};
    if (username) update.username = username;
    if (wallet) {
      if (!isValidPublicKey(wallet)) {
        return res.status(400).json({ error: "Wallet inválida" });
      }
      update.wallet = wallet;
    }
    if (password) update.password = await bcrypt.hash(password, 10);

    const db = getDB();
    const merchants = db.collection("merchants");
    const merchant = await merchants.findOne({ _id: new ObjectId(id) });
    if (!merchant) {
      return res.status(404).json({ error: "Merchant no encontrado" });
    }

    if (Object.keys(update).length === 0) {
      return res.json({ success: true });
    }

    await merchants.updateOne({ _id: merchant._id }, { $set: update });

    if (wallet) {
      await db.collection("privateKeys").updateMany(
        { merchantId: merchant._id },
        { $set: { walletAddress: wallet } }
      );
      clearBalanceCache(merchant.wallet);
      clearBalanceCache(wallet);
    }

    res.json({ success: true });
  } catch (e) {
    console.error("admin PUT /merchant:", e);
    res.status(500).json({ error: "Error al editar merchant" });
  }
});

router.put("/merchant/:id/destination", checkAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { destinationWallet } = req.body || {};

    if (destinationWallet && !isValidPublicKey(destinationWallet)) {
      return res.status(400).json({ error: "Wallet de destino inválida" });
    }

    const db = getDB();
    const merchants = db.collection("merchants");
    const cleanWallet = destinationWallet ? destinationWallet.trim() : "";
    const result = await merchants.updateOne(
      { _id: new ObjectId(id) },
      { $set: { destinationWallet: cleanWallet } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Merchant no encontrado" });
    }

    res.json({ success: true, destinationWallet: cleanWallet });
  } catch (error) {
    console.error("admin PUT /merchant/:id/destination", error);
    res.status(500).json({ error: "Error al actualizar wallet de destino" });
  }
});

router.post("/merchant/:id/claim", checkAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { token } = req.body || {};
    const normalizedToken = token === "USDC" ? "USDC" : "SOL";

    const db = getDB();
    const merchants = db.collection("merchants");
    const merchant = await merchants.findOne({ _id: new ObjectId(id) });

    if (!merchant) {
      return res.status(404).json({ error: "Merchant no encontrado" });
    }

    const destinationWallet = (merchant.destinationWallet || "").trim();
    if (!destinationWallet) {
      return res
        .status(400)
        .json({ error: "Configura una wallet de destino antes de reclamar" });
    }

    if (!merchant.wallet) {
      return res.status(400).json({ error: "El merchant no tiene wallet asignada" });
    }

    const privateKeyDoc = await db
      .collection("privateKeys")
      .find({ merchantId: merchant._id })
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray();

    const storedKey = privateKeyDoc[0]?.privateKey;
    if (!storedKey) {
      return res.status(400).json({
        error:
          "No hay llave privada guardada para este merchant. Solo las wallets automáticas soportan claim.",
      });
    }

    let keypair;
    try {
      keypair = Keypair.fromSecretKey(Buffer.from(storedKey, "base64"));
    } catch (error) {
      console.error("Error al cargar secret key", error);
      return res
        .status(500)
        .json({ error: "No se pudo reconstruir la llave privada" });
    }

    if (keypair.publicKey.toBase58() !== merchant.wallet) {
      console.warn("La llave privada no coincide con la wallet del merchant");
    }

    let claimResult;
    const destinationPk = new PublicKey(destinationWallet);

    if (normalizedToken === "SOL") {
      claimResult = await executeSolClaim(keypair, destinationPk);
    } else {
      claimResult = await executeUsdcClaim(keypair, destinationPk);
    }

    if (!claimResult || !claimResult.amount || claimResult.amount <= 0) {
      return res.status(400).json({ error: "No hay saldo disponible para reclamar" });
    }

    const claimsCollection = db.collection("claims");
    await claimsCollection.insertOne({
      merchantId: merchant._id,
      merchantUsername: merchant.username,
      token: claimResult.token,
      amount: claimResult.amount,
      destinationWallet,
      signature: claimResult.signature,
      createdAt: new Date(),
    });

    clearBalanceCache(merchant.wallet);

    res.json({
      success: true,
      token: claimResult.token,
      amount: claimResult.amount,
      destinationWallet,
      signature: claimResult.signature,
    });
  } catch (error) {
    console.error("admin POST /merchant/:id/claim", error);
    res.status(500).json({ error: error.message || "Error al ejecutar claim" });
  }
});

/**
 * DELETE /admin/merchant/:id
 */
router.delete("/merchant/:id", checkAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const db = getDB();
    const merchants = db.collection("merchants");
    const merchant = await merchants.findOne({ _id: new ObjectId(id) });
    if (!merchant) {
      return res.status(404).json({ error: "Merchant no encontrado" });
    }

    await merchants.deleteOne({ _id: merchant._id });

    await db.collection("privateKeys").deleteMany({
      merchantId: merchant._id,
    });
    await db.collection("claims").deleteMany({
      merchantId: merchant._id,
    });

    clearBalanceCache(merchant.wallet);

    res.json({ success: true });
  } catch (e) {
    console.error("admin DELETE /merchant:", e);
    res.status(500).json({ error: "Error al borrar merchant" });
  }
});

/**
 * GET /admin/keys
 * Devuelve las llaves privadas almacenadas para los merchants
 */
router.get("/keys", checkAdmin, async (_req, res) => {
  try {
    const db = getDB();
    const keys = await db
      .collection("privateKeys")
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ keys });
  } catch (e) {
    console.error("admin /keys:", e);
    res.status(500).json({ error: "Error al listar llaves" });
  }
});

async function executeSolClaim(keypair, destinationPk) {
  const balanceLamports = await connection.getBalance(keypair.publicKey);
  const lamportsToSend = balanceLamports - SOL_CLAIM_FEE_BUFFER;

  if (lamportsToSend <= 0) {
    return { token: "SOL", amount: 0 };
  }

  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: destinationPk,
      lamports: lamportsToSend,
    })
  );

  const signature = await sendAndConfirmTransaction(connection, transaction, [
    keypair,
  ]);

  return {
    token: "SOL",
    amount: Number(lamportsToSend) / LAMPORTS_PER_SOL,
    signature,
  };
}

async function executeUsdcClaim(keypair, destinationPk) {
  const mintAddress = USDC_MINTS[CLUSTER];
  if (!mintAddress) {
    throw new Error("No hay mint de USDC configurado para este cluster");
  }

  const mintPk = new PublicKey(mintAddress);
  const sourceAta = getAssociatedTokenAddress(mintPk, keypair.publicKey);
  const destinationAta = getAssociatedTokenAddress(mintPk, destinationPk);

  const sourceInfo = await connection.getAccountInfo(sourceAta);
  if (!sourceInfo) {
    return { token: "USDC", amount: 0 };
  }

  const tokenBalance = await connection.getTokenAccountBalance(sourceAta);
  const rawAmount = BigInt(tokenBalance.value?.amount || "0");
  if (rawAmount <= 0n) {
    return { token: "USDC", amount: 0 };
  }

  const instructions = [];
  const destinationInfo = await connection.getAccountInfo(destinationAta);
  if (!destinationInfo) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        keypair.publicKey,
        destinationAta,
        destinationPk,
        mintPk
      )
    );
  }

  instructions.push(
    createTokenTransferInstruction(
      sourceAta,
      destinationAta,
      keypair.publicKey,
      rawAmount
    )
  );

  const transaction = new Transaction();
  instructions.forEach((ix) => transaction.add(ix));

  const signature = await sendAndConfirmTransaction(connection, transaction, [
    keypair,
  ]);

  const uiAmount = parseFloat(
    tokenBalance.value?.uiAmountString ?? `${tokenBalance.value?.uiAmount ?? 0}`
  );

  return {
    token: "USDC",
    amount: uiAmount,
    signature,
  };
}

export default router;
