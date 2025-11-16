import path from "path";
import { fileURLToPath } from "url";
import qrcode from "qrcode";
import fs from "fs";
import pkg from "whatsapp-web.js";
import { connectMongo, getDB } from "./db.js";
const { Client, MessageMedia, RemoteAuth } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUTH_FOLDER = path.join(__dirname, ".wwebjs_auth");
const CLIENT_ID = "raypay-bot";
const SESSION_COLLECTION = "whatsapp_sessions";
const LOG_COLLECTION = "whatsapp_logs";

class MongoSessionStore {
  constructor(collection) {
    this.collection = collection;
  }

  async sessionExists({ session }) {
    const doc = await this.collection.findOne({ session });
    return Boolean(doc);
  }

  async save({ session }) {
    const zipPath = `${session}.zip`;
    const data = await fs.promises.readFile(zipPath);
    await this.collection.updateOne(
      { session },
      { $set: { session, data, updatedAt: new Date() } },
      { upsert: true }
    );
  }

  async extract({ session, path: outputPath }) {
    const doc = await this.collection.findOne({ session });
    if (!doc?.data) return;

    const buffer = Buffer.isBuffer(doc.data)
      ? doc.data
      : doc.data?.buffer
        ? Buffer.from(doc.data.buffer)
        : Buffer.from(doc.data);

    await fs.promises.writeFile(outputPath, buffer);
  }

  async delete({ session }) {
    await this.collection.deleteOne({ session });
  }
}

let client = null;
let isReady = false;
let isStarting = false;
let startPromise = null;
let qrDataUrl = null;
let qrUpdatedAt = null;
let sessionStorePromise = null;
let botState = "initializing"; // initializing | qr | ready | disconnected | error
let lastError = null;

const logPrefix = "[WhatsApp Bot]";

function formatPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) {
    throw new Error("Número de WhatsApp inválido");
  }
  return `${digits}@c.us`;
}

async function handleQr(qr) {
  try {
    qrDataUrl = await qrcode.toDataURL(qr);
    qrUpdatedAt = new Date().toISOString();
    isReady = false;
    botState = "qr";
    console.log(`${logPrefix} Escanea el nuevo QR para iniciar sesión`);
  } catch (err) {
    console.error(`${logPrefix} Error generando QR`, err);
  }
}

function handleReady() {
  isReady = true;
  qrDataUrl = null;
  qrUpdatedAt = null;
  console.log(`${logPrefix} Cliente listo y conectado`);
  botState = "ready";
  lastError = null;
}

function handleAuthFailure(message) {
  console.error(`${logPrefix} Fallo de autenticación`, message);
  isReady = false;
  botState = "error";
  lastError = String(message || "auth_failure");
}

function scheduleReconnect() {
  isReady = false;
  startPromise = null;
  isStarting = false;
  botState = "disconnected";
  setTimeout(() => {
    startBot().catch((err) =>
      console.error(`${logPrefix} Error reintentando conexión`, err)
    );
  }, 3000);
}

function handleDisconnect(reason) {
  console.warn(`${logPrefix} Cliente desconectado (${reason || "sin razón"})`);
  botState = "disconnected";
  lastError = String(reason || "disconnect");
  scheduleReconnect();
}

async function ensureSessionStore() {
  if (sessionStorePromise) return sessionStorePromise;

  sessionStorePromise = (async () => {
    const db = await connectMongo();
    const collection = db.collection(SESSION_COLLECTION);
    await collection.createIndex({ session: 1 }, { unique: true });
    return new MongoSessionStore(collection);
  })();

  return sessionStorePromise;
}

async function logEvent(type, payload = {}) {
  try {
    const db = getDB();
    const collection = db.collection(LOG_COLLECTION);
    await collection.insertOne({
      type,
      payload,
      createdAt: new Date(),
    });
  } catch (error) {
    console.warn(`${logPrefix} No se pudo registrar log`, error.message);
  }
}

async function createClient() {
  const store = await ensureSessionStore();

  const newClient = new Client({
    authStrategy: new RemoteAuth({
      dataPath: AUTH_FOLDER,
      clientId: CLIENT_ID,
      store,
      backupSyncIntervalMs: 120000,
    }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--disable-gpu",
      ],
      executablePath: process.env.CHROME_PATH || undefined,
    },
  });

  newClient.on("qr", handleQr);
  newClient.on("ready", handleReady);
  newClient.on("authenticated", () =>
    console.log(`${logPrefix} Sesión autenticada`)
  );
  newClient.on("auth_failure", handleAuthFailure);
  newClient.on("disconnected", handleDisconnect);
  newClient.on("change_state", (state) =>
    console.log(`${logPrefix} Estado: ${state}`)
  );

  newClient.on("remote_session_saved", () =>
    console.log(`${logPrefix} Sesión respaldada en MongoDB`)
  );
  newClient.on("remote_session_saved", () => (botState = isReady ? "ready" : botState));

  return newClient;
}

async function startBot() {
  if (client && isReady) return client;
  if (isStarting && startPromise) return startPromise;

  isStarting = true;
  botState = "connecting";
  client = await createClient();

  startPromise = new Promise((resolve, reject) => {
    const onReady = () => {
      cleanupListeners();
      isStarting = false;
      resolve(client);
    };

    const onFailure = (err) => {
      cleanupListeners();
      isStarting = false;
      botState = "error";
      lastError = err?.message || String(err);
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const cleanupListeners = () => {
      client?.removeListener("ready", onReady);
      client?.removeListener("auth_failure", onFailure);
      client?.removeListener("disconnected", onFailure);
    };

    client.once("ready", onReady);
    client.once("auth_failure", onFailure);
    client.once("disconnected", onFailure);

    client
      .initialize()
      .catch((err) => {
        onFailure(err);
        scheduleReconnect();
      });
  });

  return startPromise;
}

async function sendTextMessage(phone, text) {
  if (!text) throw new Error("Mensaje de texto vacío");
  const cli = await startBot();
  const chatId = formatPhone(phone);
  await cli.sendMessage(chatId, text);
}

async function sendImageMessage(phone, imageUrl, caption) {
  if (!imageUrl) throw new Error("URL de imagen inválida");
  const cli = await startBot();
  const chatId = formatPhone(phone);
  const media = await MessageMedia.fromUrl(imageUrl, { unsafeMime: true });
  await cli.sendMessage(chatId, media, caption ? { caption } : {});
}

export async function sendReceipt(phone, text, imageUrl) {
  try {
    if (!text && !imageUrl) {
      throw new Error("Se requiere texto o imagen para el recibo");
    }

    if (imageUrl) {
      await sendImageMessage(phone, imageUrl, text || undefined);
    } else if (text) {
      await sendTextMessage(phone, text);
    }

    await logEvent("receipt:sent", { phone, hasImage: Boolean(imageUrl) });
  } catch (err) {
    console.error(`${logPrefix} Error enviando recibo`, err);
    await logEvent("receipt:error", {
      phone,
      hasImage: Boolean(imageUrl),
      error: err?.message || String(err),
    });
    throw err;
  }
}

export function getBotQrStatus() {
  return {
    qrDataUrl,
    updatedAt: qrUpdatedAt,
    ready: isReady,
    state: botState,
    lastError,
  };
}

// Arrancamos el bot al cargar el módulo
startBot().catch((err) =>
  console.error(`${logPrefix} No se pudo iniciar el bot`, err)
);
