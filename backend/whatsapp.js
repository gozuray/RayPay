import baileys from "@adiwajshing/baileys";
import qrcode from "qrcode";

const { default: makeWASocket, useSingleFileAuthState, DisconnectReason } = baileys;

const { state, saveCreds } = useSingleFileAuthState("./whatsapp_auth.json");

let sock = null;
let qrDataUrl = null;
let qrUpdatedAt = null;
let isReady = false;
let isStarting = false;
let startPromise = null;

async function createSocket() {
  return makeWASocket({
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
  });
}

function handleConnectionUpdate(update) {
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    qrcode
      .toDataURL(qr)
      .then((dataUrl) => {
        qrDataUrl = dataUrl;
        qrUpdatedAt = new Date().toISOString();
        isReady = false;
        console.log("🔐 Nuevo QR generado");
      })
      .catch((err) =>
        console.error("❌ Error generando QR de WhatsApp:", err)
      );
  }

  if (connection === "open") {
    console.log("✅ Cliente de WhatsApp conectado");
    qrDataUrl = null;
    qrUpdatedAt = null;
    isReady = true;
    return;
  }

  if (connection === "close") {
    const statusCode =
      lastDisconnect?.error?.output?.statusCode ||
      lastDisconnect?.error?.statusCode;
    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

    isReady = false;

    if (shouldReconnect) {
      console.log("♻️ Reconectando a WhatsApp...");
      startBot();
    } else {
      console.log("❌ Sesión cerrada, escanear nuevo QR");
    }
  }
}

export async function startBot() {
  if (isStarting && startPromise) return startPromise;

  isStarting = true;
  startPromise = (async () => {
    try {
      sock = await createSocket();

      sock.ev.on("connection.update", handleConnectionUpdate);
      sock.ev.on("creds.update", saveCreds);

      return sock;
    } catch (err) {
      console.error("❌ No se pudo iniciar el cliente de WhatsApp:", err);
      throw err;
    } finally {
      isStarting = false;
    }
  })();

  return startPromise;
}

export function getQrImage() {
  return qrDataUrl;
}

export function getBotQrStatus() {
  return {
    qrDataUrl,
    updatedAt: qrUpdatedAt,
    ready: isReady,
  };
}

export async function sendReceipt(phoneNumber, receiptData) {
  try {
    await startBot();

    if (!sock || !isReady) {
      throw new Error("Cliente de WhatsApp no inicializado o no conectado");
    }

    const jid = `${phoneNumber}@s.whatsapp.net`;

    const { amount, date, time, finalWallet, hashStart, hashEnd } =
      receiptData || {};

    const message =
      "📄 *Recibo de Pago*\n\n" +
      `Monto: ${amount || "N/A"}\n` +
      `Fecha: ${date || ""} ${time || ""}\n` +
      `Wallet destino: ...${finalWallet || ""}\n` +
      `Tx: ${hashStart || ""}...${hashEnd || ""}\n\n` +
      "Gracias por tu pago 🙌";

    await sock.sendMessage(jid, { text: message });
  } catch (err) {
    console.error("❌ Error enviando recibo por WhatsApp:", err);
    throw err;
  }
}

await startBot();
