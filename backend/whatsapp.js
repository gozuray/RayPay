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

let socket;
let authState;
let initPromise;
let isReady = false;
let latestQrDataUrl = null;
let latestQrAt = null;
let refreshingQr = false;
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
    await authState?.saveState?.();
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
      await fs.unlink(AUTH_FILE_PATH).catch(() => {});
      resetQr();
      initPromise = null;
      authState = null;
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
    authState = useSingleFileAuthState(AUTH_FILE_PATH);
    socket = makeWASocket({
      auth: authState.state,
      printQRInTerminal: false,
      browser: ["RayPay", "Render", "1.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    socket.ev.on("creds.update", authState.saveState);
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
