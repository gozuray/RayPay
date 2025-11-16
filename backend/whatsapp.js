import qrcode from "qrcode";
import {
  makeWASocket,
  BufferJSON,
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  makeCacheableSignalKeyStore,
} from "baileys";

import { connectMongo, getDB } from "./db.js";

const SESSION_ID = "raypay";

let socket;
let authState;
let initPromise;
let isReady = false;
let latestQrDataUrl = null;
let latestQrAt = null;
let refreshingQr = false;
let versionPromise;
let connecting = false;

async function refreshQr(reason = "manual") {
  if (refreshingQr || connecting) return;

  refreshingQr = true;

  try {
    console.log(`🔄 Solicitando nuevo QR de WhatsApp (${reason})`);
    resetQr();
    await initializeClient();
  } catch (err) {
    console.error("No se pudo refrescar el QR de WhatsApp:", err);
  } finally {
    refreshingQr = false;
  }
}

async function getSessionsCollection() {
  await connectMongo();
  return getDB().collection("whatsapp_sessions");
}

async function createMongoAuthState(sessionId = SESSION_ID) {
  const collection = await getSessionsCollection();
  const doc = await collection.findOne({ sessionId });

  const parseSafe = (raw, fallback) => {
    try {
      return JSON.parse(JSON.stringify(raw ?? fallback), BufferJSON.reviver);
    } catch (err) {
      console.warn(
        "⚠️ No se pudo leer la sesión previa de WhatsApp, se regenerará",
        err?.message
      );
      return fallback;
    }
  };

  // Migración de formato: si existe "data" (string) se parsea, si no se usan
  // los campos separados "creds" y "keys".
  const parsedLegacy = doc?.data
    ? parseSafe(
        typeof doc.data === "string" ? doc.data : doc.data.toString(),
        null
      )
    : null;

  const creds = parsedLegacy?.creds
    ? parsedLegacy.creds
    : parseSafe(doc?.creds, initAuthCreds());
  const keys = parsedLegacy?.keys ? parsedLegacy.keys : parseSafe(doc?.keys, {});

  const serialize = (value) => JSON.parse(JSON.stringify(value, BufferJSON.replacer));
  let writeQueue = Promise.resolve();

  const writeData = async () => {
    writeQueue = writeQueue
      .catch(() => {})
      .then(async () => {
        await collection.updateOne(
          { sessionId },
          {
            $set: {
              sessionId,
              creds: serialize(creds),
              keys: serialize(keys),
              updatedAt: new Date(),
            },
            $unset: { data: "" },
          },
          { upsert: true }
        );
      });

    return writeQueue;
  };

  return {
    state: {
      creds,
      keys: makeCacheableSignalKeyStore(keys, writeData),
    },
    saveCreds: writeData,
    clearState: async () => collection.deleteOne({ sessionId }),
  };
}

function resetQr() {
  latestQrDataUrl = null;
  latestQrAt = new Date().toISOString();
}

async function handleConnectionUpdate(update) {
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    try {
      latestQrDataUrl = await qrcode.toDataURL(qr, {
        errorCorrectionLevel: "M",
        margin: 1,
      });
      latestQrAt = new Date().toISOString();
      isReady = false;
    } catch (err) {
      console.error("No se pudo generar el QR de WhatsApp:", err);
    }
  }

  if (connection === "open") {
    isReady = true;
    connecting = false;
    resetQr();
    console.log("✅ Cliente de WhatsApp listo (Baileys)");
    await authState?.saveCreds?.();
    return;
  }

  if (connection === "close") {
    isReady = false;
    connecting = false;
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const shouldReconnect =
      statusCode !== DisconnectReason.loggedOut &&
      statusCode !== DisconnectReason.badSession;

    if (!shouldReconnect) {
      await authState?.clearState?.();
      resetQr();
      initPromise = null;
      console.warn("🔌 Sesión de WhatsApp eliminada, se requiere nuevo QR");
      return;
    }

    console.warn("⚠️ Cliente de WhatsApp desconectado, reintentando...");
    initPromise = null;
    setTimeout(() => initializeClient().catch(() => {}), 3000);
  }
}

async function initializeClient() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    connecting = true;
    authState = await createMongoAuthState();
    const { version } = await fetchLatestBaileysVersion();

    socket = makeWASocket({
      version,
      auth: authState.state,
      printQRInTerminal: false,
      browser: ["RayPay", "Render", "1.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    socket.ev.on("creds.update", authState.saveCreds);
    socket.ev.on("connection.update", (update) => {
      handleConnectionUpdate(update).catch((err) =>
        console.error("Error manejando actualización de conexión:", err)
      );
    });

    return socket;
  })().catch((err) => {
    connecting = false;
    initPromise = null;
    throw err;
  });

 
  return initPromise;
}

async function ensureReady(timeoutMs = 15000) {
  const sock = await initializeClient();
  if (isReady) return sock;

  const waitForReady = new Promise((resolve) => {
    const handler = (update) => {
      if (update.connection === "open") {
        sock.ev.off("connection.update", handler);
        resolve();
      }
    };
    sock.ev.on("connection.update", handler);
  });

  const timeoutError = new Promise((_, reject) => {
    setTimeout(() => {
      reject(
        new Error(
          latestQrDataUrl
            ? "El bot de WhatsApp no está conectado. Escanea el nuevo QR."
            : "El bot de WhatsApp no está listo. Inténtalo en unos segundos."
        )
      );
    }, timeoutMs);
  });

  await Promise.race([waitForReady, timeoutError]);

  if (!isReady) {
    throw new Error("El bot de WhatsApp sigue desconectado");
  }

  return sock;
}

function formatPhone(number) {
  const digits = String(number || "").replace(/\D/g, "");
  return digits ? `${digits}@s.whatsapp.net` : "";
}

export function getBotQrStatus() {
  if (!isReady) {
    const qrAgeMs = latestQrAt ? Date.now() - new Date(latestQrAt).getTime() : null;

    if (
      !refreshingQr &&
      !connecting &&
      (!latestQrDataUrl || (qrAgeMs ?? Infinity) > 20000)
    ) {
      refreshQr(!latestQrDataUrl ? "missing-qr" : "stale-qr").catch(() => {});
    }
  }

  return {
    qrDataUrl: latestQrDataUrl,
    updatedAt: latestQrAt,
    ready: isReady,
  };
}

export async function sendReceipt(number, data = {}) {
  const jid = formatPhone(number);
  if (!jid) {
    console.warn("📵 Número de WhatsApp no proporcionado, se omite el envío");
    return { sent: false, reason: "missing_number" };
  }

  const sock = await ensureReady();

  const message = `📄 *Recibo de pago - RayPay*\n\n` +
    `💰 Monto: ${data.amount ?? "--"} USDC\n` +
    `📅 Fecha: ${data.date ?? "--"}\n` +
    `⏰ Hora: ${data.time ?? "--"}\n\n` +
    `🔑 Cliente pagó a:\n` +
    `...${data.finalWallet ?? "---"}\n\n` +
    `🧾 Hash parcial:\n` +
    `${data.hashStart ?? ""}...${data.hashEnd ?? ""}\n\n` +
    `Gracias por tu compra 💙`;

  try {
    await sock.sendMessage(jid, { text: message });
    console.log(`📨 Recibo enviado a ${jid}`);
    return { sent: true };
  } catch (err) {
    console.error("❌ Error enviando recibo de WhatsApp:", err);
    throw err;
  }
}

initializeClient().catch((err) => {
  console.error("No se pudo inicializar WhatsApp:", err);
});
