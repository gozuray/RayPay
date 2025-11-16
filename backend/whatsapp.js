import fs from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import qrcode from "qrcode";
import makeWASocket, {
  DisconnectReason,
  useSingleFileAuthState,
} from "@adiwajshing/baileys";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE_PATH = join(__dirname, "whatsapp_auth.json");

let socket = null;
let authState = null;
let qrImage = null;
let qrUpdatedAt = null;
let isReady = false;
let reconnectTimer = null;
let isStarting = false;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function generateQr(data) {
  try {
    qrImage = await qrcode.toDataURL(data, {
      errorCorrectionLevel: "M",
      margin: 1,
    });
    qrUpdatedAt = new Date().toISOString();
  } catch (err) {
    console.error("No se pudo generar el QR de WhatsApp:", err);
    qrImage = null;
    qrUpdatedAt = null;
  }
}

async function handleConnectionUpdate(update) {
  const { connection, lastDisconnect, qr } = update || {};

  if (qr) {
    await generateQr(qr);
  }

  if (connection === "open") {
    isReady = true;
    qrImage = null;
    qrUpdatedAt = null;
    return;
  }

  if (connection === "close") {
    isReady = false;
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const shouldReconnect =
      statusCode !== DisconnectReason.loggedOut &&
      statusCode !== DisconnectReason.badSession;

    if (!shouldReconnect) {
      await fs.unlink(AUTH_FILE_PATH).catch(() => {});
      socket = null;
      authState = null;
      return;
    }

    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        socket = null;
        startBot().catch((err) =>
          console.error("No se pudo reconectar a WhatsApp:", err)
        );
      }, 3000);
    }
  }
}

function createSocket() {
  const { state, saveState } = authState;
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ["RayPay", "Render", "1.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveState);
  sock.ev.on("connection.update", (u) => {
    handleConnectionUpdate(u).catch((err) =>
      console.error("Error manejando conexión de WhatsApp:", err)
    );
  });

  return sock;
}

async function waitForReady(timeoutMs = 20000) {
  if (isReady && socket) return socket;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isReady && socket) return socket;
    await wait(500);
  }

  throw new Error("El bot de WhatsApp no está listo; escanea el QR y reintenta.");
}

export async function startBot() {
  if (socket || isStarting) return socket;

  isStarting = true;

  try {
    authState = authState ?? useSingleFileAuthState(AUTH_FILE_PATH);
    socket = createSocket();
    return socket;
  } finally {
    isStarting = false;
  }
}

export function getQrImage() {
  return qrImage;
}

export async function sendReceipt(number, data = {}) {
  const digits = String(number || "").replace(/\D/g, "");
  if (!digits) {
    console.warn("📵 Número de WhatsApp no proporcionado, se omite el envío");
    return { sent: false, reason: "missing_number" };
  }

  const jid = `${digits}@s.whatsapp.net`;
  await startBot();
  const sock = await waitForReady();

  const message = `📄 *Recibo de pago - RayPay*\n\n` +
    `💰 Monto: ${data.amount ?? "--"} USDC\n` +
    `📅 Fecha: ${data.date ?? "--"}\n` +
    `⏰ Hora: ${data.time ?? "--"}\n\n` +
    `🔑 Cliente pagó a:\n` +
    `...${data.finalWallet ?? "---"}\n\n` +
    `🧾 Hash parcial:\n` +
    `${data.hashStart ?? ""}...${data.hashEnd ?? ""}\n\n` +
    `Gracias por tu compra 💙`;

  await sock.sendMessage(jid, { text: message });
  console.log(`📨 Recibo enviado a ${jid}`);
  return { sent: true };
}

export function getBotQrStatus() {
  return {
    qrDataUrl: qrImage,
    updatedAt: qrUpdatedAt,
    ready: isReady,
  };
}

startBot().catch((err) => {
  console.error("No se pudo iniciar el cliente de WhatsApp:", err);
});
