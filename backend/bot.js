import path from "path";
import { fileURLToPath } from "url";
import qrcode from "qrcode";
import { Client, LocalAuth, MessageMedia } from "whatsapp-web.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUTH_FOLDER = path.join(__dirname, ".wwebjs_auth");
const CLIENT_ID = "raypay-bot";

let client = null;
let isReady = false;
let isStarting = false;
let startPromise = null;
let qrDataUrl = null;
let qrUpdatedAt = null;

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
}

function handleAuthFailure(message) {
  console.error(`${logPrefix} Fallo de autenticación`, message);
  isReady = false;
}

function scheduleReconnect() {
  isReady = false;
  startPromise = null;
  isStarting = false;
  setTimeout(() => {
    startBot().catch((err) =>
      console.error(`${logPrefix} Error reintentando conexión`, err)
    );
  }, 3000);
}

function handleDisconnect(reason) {
  console.warn(`${logPrefix} Cliente desconectado (${reason || "sin razón"})`);
  scheduleReconnect();
}

function createClient() {
  const newClient = new Client({
    authStrategy: new LocalAuth({
      dataPath: AUTH_FOLDER,
      clientId: CLIENT_ID,
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

  return newClient;
}

async function startBot() {
  if (client && isReady) return client;
  if (isStarting && startPromise) return startPromise;

  isStarting = true;
  client = createClient();

  startPromise = new Promise((resolve, reject) => {
    const onReady = () => {
      cleanupListeners();
      isStarting = false;
      resolve(client);
    };

    const onFailure = (err) => {
      cleanupListeners();
      isStarting = false;
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
  } catch (err) {
    console.error(`${logPrefix} Error enviando recibo`, err);
    throw err;
  }
}

export function getBotQrStatus() {
  return {
    qrDataUrl,
    updatedAt: qrUpdatedAt,
    ready: isReady,
  };
}

// Arrancamos el bot al cargar el módulo
startBot().catch((err) =>
  console.error(`${logPrefix} No se pudo iniciar el bot`, err)
);
