import makeWASocket, {
  useSingleFileAuthState,
  DisconnectReason
} from "@adiwajshing/baileys";
import qrcode from "qrcode";

const { state, saveState } = useSingleFileAuthState("./whatsapp_auth.json");

let sock = null;
let qrDataUrl = null;
let qrUpdatedAt = null;
let isReady = false;
let isStarting = false;

export async function startBot() {
  if (isStarting) return;

  isStarting = true;
  try {
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrDataUrl = await qrcode.toDataURL(qr);
        qrUpdatedAt = new Date().toISOString();
        isReady = false;
        console.log("🔐 Nuevo QR generado");
      }

      if (connection === "open") {
        console.log("✅ Cliente de WhatsApp conectado");
        qrDataUrl = null;
        qrUpdatedAt = null;
        isReady = true;
      }

      if (connection === "close") {
        const reason = lastDisconnect?.error?.output?.statusCode;

        isReady = false;

        if (reason !== DisconnectReason.loggedOut) {
          console.log("♻️ Reconectando a WhatsApp...");
          startBot();
        } else {
          console.log("❌ Sesión cerrada, escanear nuevo QR");
        }
      }
    });

    sock.ev.on("creds.update", saveState);
  } catch (err) {
    console.error("❌ No se pudo iniciar el cliente de WhatsApp:", err);
  } finally {
    isStarting = false;
  }
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
    if (!sock) {
      await startBot();
    }

    if (!sock) {
      throw new Error("Cliente de WhatsApp no inicializado");
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
