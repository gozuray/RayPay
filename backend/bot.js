import path from "path";
import { fileURLToPath } from "url";
import qrcode from "qrcode";
import fs from "fs";
import os from "os";
import pkg from "whatsapp-web.js";
import { connectMongo, getDB } from "./db.js";
const { Client, MessageMedia, RemoteAuth } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_ID = "raypay-bot";
const SESSION_NAME = CLIENT_ID ? `RemoteAuth-${CLIENT_ID}` : "RemoteAuth";
const SESSION_ZIP_PATH = path.join(process.cwd(), `${SESSION_NAME}.zip`);
const SESSION_COLLECTION = "whatsapp_sessions";
const LOG_COLLECTION = "whatsapp_logs";
const LOG_TTL_DAYS = Number(process.env.LOG_TTL_DAYS || 7);

let authFolderPromise = null;

async function ensureAuthFolder() {
  if (!authFolderPromise) {
    authFolderPromise = fs.promises.mkdtemp(
      path.join(os.tmpdir(), `${CLIENT_ID}_`)
    );
  }
  return authFolderPromise;
}

class MongoSessionStore {
  constructor(collection) {
    this.collection = collection;
  }

  #resolveId({ clientId, session }) {
    return clientId || session;
  }

  async sessionExists({ clientId, session }) {
    const id = this.#resolveId({ clientId, session });
    if (!id) return false;
    const doc = await this.collection.findOne({ clientId: id });
    return Boolean(doc);
  }

  // 🔧 Corregido: ya no revienta si RemoteAuth llama sin data ni path
  async save({ clientId, data, session, path: zipPath }) {
    const id = this.#resolveId({ clientId, session });
    if (!id) {
      console.warn("[WhatsApp Bot] RemoteAuth.save() sin clientId/session válido, se omite");
      return;
    }

    let buffer = null;

    if (data) {
      buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    } else if (zipPath) {
      try {
        buffer = await fs.promises.readFile(zipPath);
      } catch (err) {
        console.warn(
          `[WhatsApp Bot] No se pudo leer ZIP de sesión desde ${zipPath}:`,
          err.message
        );
      }
    }

    if (!buffer) {
      console.warn(
        `[WhatsApp Bot] RemoteAuth.save() llamado sin data ni ZIP para clientId=${id}, se omite`
      );
      return;
    }

    await this.collection.updateOne(
      { clientId: id },
      { $set: { clientId: id, data: buffer, updatedAt: new Date() } },
      { upsert: true }
    );

    if (zipPath) {
      await fs.promises.rm(zipPath, { force: true }).catch(() => {});
    }
  }

  async extract({ clientId, session, path: outputPath }) {
    const id = this.#resolveId({ clientId, session });
    if (!id) return;

    const doc = await this.collection.findOne({ clientId: id });
    if (!doc?.data) return;

    const buffer = Buffer.isBuffer(doc.data)
      ? doc.data
      : doc.data?.buffer
      ? Buffer.from(doc.data.buffer)
      : Buffer.from(doc.data);

    const targetPath = outputPath || path.resolve(process.cwd(), `${id}.zip`);
    const dir = path.dirname(targetPath);
    if (dir && dir !== ".") {
      await fs.promises.mkdir(dir, { recursive: true });
    }
    await fs.promises.writeFile(targetPath, buffer);

    return buffer;
  }

  async delete({ clientId, session }) {
    const id = this.#resolveId({ clientId, session });
    if (!id) return;
    await this.collection.deleteOne({ clientId: id });
  }
}

let client = null;
let isReady = false;
let isStarting = false;
let startPromise = null;
let startLock = Promise.resolve();
let qrDataUrl = null;
let qrUpdatedAt = null;
let sessionStorePromise = null;
let botState = "initializing"; // initializing | qr | ready | disconnected | error
let lastError = null;
let authFolderPath = null;

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
  if (client) {
    client.destroy().catch(() => {});
    client = null;
  }
  cleanupTempAuthFolder();
  scheduleReconnect();
}

async function ensureSessionStore() {
  if (sessionStorePromise) return sessionStorePromise;

  sessionStorePromise = (async () => {
    const db = await connectMongo();
    const collection = db.collection(SESSION_COLLECTION);
    await collection.createIndex({ clientId: 1 }, { unique: true });
    if (LOG_TTL_DAYS > 0) {
      await db.collection(LOG_COLLECTION).createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: LOG_TTL_DAYS * 24 * 60 * 60 }
      );
    }
    return new MongoSessionStore(collection);
  })();

  return sessionStorePromise;
}

async function prepareRemoteSession(store) {
  const hasSession = await store.sessionExists({ clientId: SESSION_NAME });
  if (!hasSession) return;
  await store.extract({
    clientId: SESSION_NAME,
    session: SESSION_NAME,
    path: SESSION_ZIP_PATH,
  });
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

async function createClient(store) {
  const sessionStore = store || (await ensureSessionStore());
  authFolderPath = await ensureAuthFolder();
  await cleanupOldTempAuthFolders();

  const newClient = new Client({
    authStrategy: new RemoteAuth({
      dataPath: authFolderPath,
      clientId: CLIENT_ID,
      store: sessionStore,
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

  newClient.on("remote_session_saved", async () => {
    console.log(`${logPrefix} Sesión respaldada en MongoDB`);
    botState = isReady ? "ready" : botState;
    await cleanupOldTempAuthFolders();
  });

  return newClient;
}

async function startBot() {
  return withStartLock(async () => {
    if (client && isReady) return client;
    if (isStarting && startPromise) return startPromise;

    isStarting = true;
    botState = "connecting";
    const store = await ensureSessionStore();
    await prepareRemoteSession(store);
    if (!client) {
      client = await createClient(store);
    }

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
        client = null;
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
  });
}

function withStartLock(fn) {
  let release;
  const currentLock = startLock;
  startLock = new Promise((resolve) => {
    release = resolve;
  });

  return currentLock
    .catch(() => {})
    .then(async () => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
}

async function sendTextMessage(phone, text) {
  if (!text) throw new Error("Mensaje de texto vacío");
  const cli = await startBot();
  const chatId = formatPhone(phone);
  console.log(`${logPrefix} Enviando mensaje de texto a ${chatId}`);
  await cli.sendMessage(chatId, text);
}

async function sendImageMessage(phone, imageUrl, caption) {
  if (!imageUrl) throw new Error("URL de imagen inválida");
  const cli = await startBot();
  const chatId = formatPhone(phone);
  console.log(`${logPrefix} Enviando imagen a ${chatId}: ${imageUrl}`);
  const media = await MessageMedia.fromUrl(imageUrl, { unsafeMime: true });
  await cli.sendMessage(chatId, media, caption ? { caption } : {});
}

export async function sendReceipt(phone, text, imageUrl) {
  try {
    if (!text && !imageUrl) {
      throw new Error("Se requiere texto o imagen para el recibo");
    }

    const normalizedPhone = formatPhone(phone);
    console.log(
      `${logPrefix} [Recibo] Inicio envío a ${normalizedPhone} ` +
        `(texto=${Boolean(text)}, imagen=${Boolean(imageUrl)})`
    );

    if (imageUrl) {
      await sendImageMessage(normalizedPhone, imageUrl, text || undefined);
    } else if (text) {
      await sendTextMessage(normalizedPhone, text);
    }

    console.log(`${logPrefix} [Recibo] Envío exitoso a ${normalizedPhone}`);

    await logEvent("receipt:sent", {
      phone: normalizedPhone,
      hasImage: Boolean(imageUrl),
    });
  } catch (err) {
    console.error(`${logPrefix} [Recibo] Error enviando recibo`, err);
    await logEvent("receipt:error", {
      phone: formatPhone(phone),
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

async function cleanupTempAuthFolder() {
  if (!authFolderPath) return;
  try {
    await fs.promises.rm(authFolderPath, { recursive: true, force: true });
    authFolderPath = null;
    authFolderPromise = null;
  } catch (err) {
    console.warn(`${logPrefix} No se pudo limpiar carpeta temporal`, err);
  }
}

async function cleanupOldTempAuthFolders() {
  try {
    const base = os.tmpdir();
    const entries = await fs.promises.readdir(base, { withFileTypes: true });
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            entry.name.startsWith(`${CLIENT_ID}_`) &&
            path.join(base, entry.name) !== authFolderPath
        )
        .map((entry) =>
          fs.promises.rm(path.join(base, entry.name), {
            recursive: true,
            force: true,
          })
        )
    );
  } catch (err) {
    console.warn(`${logPrefix} No se pudieron limpiar carpetas viejas`, err);
  }
}

function registerCleanupHooks() {
  const cleanup = async () => {
    await cleanupTempAuthFolder();
  };

  process.on("exit", cleanup);
  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });
}

registerCleanupHooks();
