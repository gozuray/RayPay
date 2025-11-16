import pkg from "whatsapp-web.js";
import qrcode from "qrcode-terminal";

const { Client, LocalAuth } = pkg;

let isReady = false;
let initPromise;

const client = new Client({
  authStrategy: new LocalAuth({ clientId: "raypay" }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

client.on("qr", (qr) => {
  console.log("📲 Escanea este QR para iniciar sesión en WhatsApp");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  isReady = true;
  console.log("✅ Cliente de WhatsApp listo");
});

client.on("authenticated", () => {
  console.log("🔐 Sesión de WhatsApp autenticada");
});

client.on("disconnected", (reason) => {
  isReady = false;
  initPromise = null;
  console.warn("⚠️ Cliente de WhatsApp desconectado:", reason);
  setTimeout(() => initializeClient().catch(() => {}), 5000);
});

function initializeClient() {
  if (!initPromise) {
    initPromise = client.initialize();
  }
  return initPromise;
}

async function ensureReady() {
  await initializeClient();
  if (isReady) return;
  await new Promise((resolve) => client.once("ready", resolve));
}

function formatPhone(number) {
  const digits = String(number || "").replace(/\D/g, "");
  return digits ? `${digits}@c.us` : "";
}

export async function sendReceipt(number, data = {}) {
  const chatId = formatPhone(number);
  if (!chatId) {
    console.warn("📵 Número de WhatsApp no proporcionado, se omite el envío");
    return { sent: false, reason: "missing_number" };
  }

  await ensureReady();

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
    await client.sendMessage(chatId, message);
    console.log(`📨 Recibo enviado a ${chatId}`);
    return { sent: true };
  } catch (err) {
    console.error("❌ Error enviando recibo de WhatsApp:", err);
    throw err;
  }
}

initializeClient().catch((err) => {
  console.error("No se pudo inicializar WhatsApp:", err);
});
