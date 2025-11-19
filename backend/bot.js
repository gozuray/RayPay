import fs from "fs";
import os from "os";
import path from "path";
import qrcode from "qrcode";
import { fileURLToPath } from "url";
import pkg from "whatsapp-web.js";
import { connectMongo, getDB } from "./db.js";

const { Client, MessageMedia, RemoteAuth } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BOT_SINGLETON_KEY = Symbol.for("raypay.whatsapp.bot.singleton");

function createSingleton() {
  const CLIENT_ID = "raypay-bot";
  // Usar el mismo identificador que RemoteAuth para la sesión
  const SESSION_NAME = CLIENT_ID;
  const SESSION_ZIP_PATH = path.join(process.cwd(), `${SESSION_NAME}.zip`);
  const SESSION_COLLECTION = "whatsapp_sessions";
  const LOG_COLLECTION = "whatsapp_logs";
  const LOG_TTL_DAYS = Number(process.env.LOG_TTL_DAYS || 7);
  const logPrefix = "[WhatsApp Bot]";

  let authFolderPromise = null;
  let authFolderPath = null;
  let sessionStorePromise = null;
  let client = null;
  let isReady = false;
  let isStarting = false;
  let startPromise = null;
  let startLock = Promise.resolve();
  let qrDataUrl = null;
  let qrUpdatedAt = null;
  let botState = "initializing"; // initializing | qr | ready | disconnected | error | connecting
  let lastError = null;

  async function ensureAuthFolder() {
  if (!authFolderPath) {
    authFolderPath = "/tmp/whatsapp-session";
    await fs.promises.mkdir(authFolderPath, { recursive: true });
  }
  return authFolderPath;
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

    async save({ clientId, data, session, path: zipPath }) {
      const id = this.#resolveId({ clientId, session });
      if (!id) {
        console.warn(
          `${logPrefix} RemoteAuth.save() sin clientId/session válido, se omite`
        );
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
            `${logPrefix} No se pudo leer ZIP de sesión desde ${zipPath}: ${err.message}`
          );
        }
      }

      if (!buffer || buffer.length === 0) {
        console.warn(
          `${logPrefix} ⚠ No se recibió data de sesión válida, se mantiene la sesión previa`
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

      console.log(
        `${logPrefix} Restaurando sesión desde MongoDB → ZIP size: ${
          buffer?.length || 0
        } bytes`
      );

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

  async function ensureSessionStore() {
    if (sessionStorePromise) return sessionStorePromise;

    sessionStorePromise = (async () => {
      const db = await connectMongo();
      const collection = db.collection(SESSION_COLLECTION);
      await collection.createIndex({ clientId: 1 }, { unique: true });
      if (LOG_TTL_DAYS > 0) {
        await db
          .collection(LOG_COLLECTION)
          .createIndex(
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

  function handleQr(qr) {
    return qrcode
      .toDataURL(qr)
      .then((dataUrl) => {
        qrDataUrl = dataUrl;
        qrUpdatedAt = new Date().toISOString();
        isReady = false;
        botState = "qr";
        console.log(`${logPrefix} Escanea el nuevo QR para iniciar sesión`);
      })
      .catch((err) => console.error(`${logPrefix} Error generando QR`, err));
  }

  function handleReady() {
    isReady = true;
    qrDataUrl = null;
    qrUpdatedAt = null;
    botState = "ready";
    lastError = null;
    console.log(`${logPrefix} Cliente listo y conectado`);
  }

  function handleAuthFailure(message) {
    isReady = false;
    botState = "error";
    lastError = String(message || "auth_failure");
    console.error(`${logPrefix} Fallo de autenticación`, message);
  }

  function cleanupStartupState() {
    isStarting = false;
    startPromise = null;
  }

  function scheduleReconnect() {
    botState = "disconnected";
    isReady = false;
    cleanupStartupState();
    setTimeout(() => {
      startBot().catch((err) =>
        console.error(`${logPrefix} Error reintentando conexión`, err)
      );
    }, 3000);
  }

  async function cleanupTempAuthFolder() {
    if (!authFolderPath) return;
    try {
      await fs.promises.rm(authFolderPath, { recursive: true, force: true });
    } catch (err) {
      console.warn(`${logPrefix} No se pudo limpiar carpeta temporal`, err);
    } finally {
      authFolderPath = null;
      authFolderPromise = null;
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

  function withStartLock(fn) {
    let release;
    const prev = startLock;
    startLock = new Promise((resolve) => {
      release = resolve;
    });

    return prev
      .catch(() => {})
      .then(async () => {
        try {
          return await fn();
        } finally {
          release();
        }
      });
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
    newClient.on("disconnected", (reason) => {
      console.warn(
        `${logPrefix} Cliente desconectado (${reason || "sin razón"})`
      );
      cleanupTempAuthFolder();
      scheduleReconnect();
    });
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
      if (client && isReady && !isStarting) return client;
      if (startPromise && isStarting) return startPromise;

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
          handleReady();
          isStarting = false;
          startPromise = Promise.resolve(client);
          resolve(client);
        };

        const onFailure = (err) => {
          cleanupListeners();
          handleAuthFailure(err);
          client = null;
          cleanupStartupState();
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

        client.initialize().catch((err) => {
          onFailure(err);
          scheduleReconnect();
        });
      });

      return startPromise;
    });
  }

  function formatPhone(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (!digits) {
      throw new Error("Número de WhatsApp inválido");
    }
    return `${digits}@c.us`;
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

  async function sendReceipt(phone, text, imageUrl) {
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

  function getBotQrStatus() {
    return {
      qrDataUrl,
      updatedAt: qrUpdatedAt,
      ready: isReady,
      state: botState,
      lastError,
    };
  }

  registerCleanupHooks();
  startBot().catch((err) =>
    console.error(`${logPrefix} No se pudo iniciar el bot`, err)
  );

  return {
    startBot,
    sendReceipt,
    getBotQrStatus,
  };
}

const singleton =
  globalThis[BOT_SINGLETON_KEY] ||
  (globalThis[BOT_SINGLETON_KEY] = createSingleton());

export const startBot = singleton.startBot;
export const sendReceipt = singleton.sendReceipt;
export const getBotQrStatus = singleton.getBotQrStatus;
