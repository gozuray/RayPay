import qrcode from "qrcode";
import makeWASocket, {
  DisconnectReason,
  useSingleFileAuthState,
} from "@adiwajshing/baileys";

const AUTH_FILE = "./whatsapp_auth.json";
const { state, saveState } = useSingleFileAuthState(AUTH_FILE);

let sock = null;
let qrImage = null;
let isReady = false;
let reconnecting = false;

async function generateQr(qr) {
  try {
    qrImage = await qrcode.toDataURL(qr);
  } catch (error) {
    console.error("No se pudo generar la imagen QR de WhatsApp:", error);
    qrImage = null;
  }
}

function setupEventHandlers(instance) {
  instance.ev.on("creds.update", saveState);

  instance.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update || {};

    if (qr) {
      await generateQr(qr);
    }

    if (connection === "open") {
      isReady = true;
      qrImage = null;
      reconnecting = false;
      return;
    }

    if (connection === "close") {
      isReady = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect && !reconnecting) {
        reconnecting = true;
        setTimeout(() => {
          reconnecting = false;
          sock = null;
          startBot().catch((err) =>
            console.error("Error al reconectar a WhatsApp:", err)
          );
        }, 2000);
      }
    }
  });
}

function createSocket() {
  const instance = makeWASocket({
    auth: state,
    browser: ["RayPay", "Render", "1.0"],
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  setupEventHandlers(instance);
  return instance;
}

async function ensureReady(timeoutMs = 20000) {
  const start = Date.now();
  while (!isReady && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (!isReady) {
    throw new Error("Escanea el código QR de WhatsApp y vuelve a intentar.");
  }

  return sock;
}

export async function startBot() {
  if (sock) return sock;

  sock = createSocket();
  return sock;
}

export function getQrImage() {
  return qrImage;
}

export async function sendReceipt(number, data = {}) {
  const digits = String(number || "").replace(/\D/g, "");
  if (!digits) {
    console.warn("Número de WhatsApp no proporcionado, se omite el envío");
    return { sent: false, reason: "missing_number" };
  }

  await startBot();
  const client = await ensureReady();
  const jid = `${digits}@s.whatsapp.net`;

  const message =
    `📄 *Recibo de pago - RayPay*\n\n` +
    `💰 Monto: ${data.amount ?? "--"} USDC\n` +
    `📅 Fecha: ${data.date ?? "--"}\n` +
    `⏰ Hora: ${data.time ?? "--"}\n\n` +
    `🔑 Cliente pagó a:\n` +
    `...${data.finalWallet ?? "---"}\n\n` +
    `🧾 Hash parcial:\n` +
    `${data.hashStart ?? ""}...${data.hashEnd ?? ""}\n\n` +
    `Gracias por tu compra 💙`;

  await client.sendMessage(jid, { text: message });
  console.log(`Recibo enviado a ${jid}`);
  return { sent: true };
}

startBot().catch((err) => {
  console.error("No se pudo iniciar el bot de WhatsApp:", err);
});
