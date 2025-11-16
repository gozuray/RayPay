import fs from "fs/promises";
import pkg from "whatsapp-web.js";
import qrcode from "qrcode";

import { connectMongo, getDB } from "./db.js";

const { Client, RemoteAuth } = pkg;

let isReady = false;
let initPromise;
let latestQrDataUrl = null;
let latestQrAt = null;

class MongoStore {
  async getCollection() {
    await connectMongo();
    return getDB().collection("whatsapp_sessions");
  }

  async sessionExists({ session }) {
    const collection = await this.getCollection();
    const doc = await collection.findOne({ session });
    return Boolean(doc);
  }

  async extract({ session, path }) {
    const collection = await this.getCollection();
    const doc = await collection.findOne({ session });
    if (doc?.data?.buffer) {
      await fs.writeFile(path, doc.data.buffer);
    }
  }

  async save({ session }) {
    const collection = await this.getCollection();
    const zipPath = `${session}.zip`;
    const data = await fs.readFile(zipPath);
    await collection.updateOne(
      { session },
      { $set: { session, data, updatedAt: new Date() } },
      { upsert: true }
    );
  }

  async delete({ session }) {
    const collection = await this.getCollection();
    await collection.deleteOne({ session });
  }
}

const client = new Client({
  authStrategy: new RemoteAuth({
    clientId: "raypay",
    store: new MongoStore(),
    backupSyncIntervalMs: 5 * 60 * 1000,
  }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

client.on("qr", async (qr) => {
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
});

client.on("ready", () => {
  isReady = true;
  latestQrDataUrl = null;
  latestQrAt = new Date().toISOString();
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

async function ensureReady(timeoutMs = 10000) {
  await initializeClient();
  if (isReady) return;

  const timeoutError = new Promise((_, reject) =>
    setTimeout(() =>
      reject(
        new Error(
          latestQrDataUrl
            ? "El bot de WhatsApp no está conectado. Escanea el QR nuevamente."
            : "El bot de WhatsApp no está listo. Inténtalo en unos segundos."
        )
      ),
      timeoutMs
    )
  );

  await Promise.race([
    new Promise((resolve) => client.once("ready", resolve)),
    timeoutError,
  ]);

  if (!isReady) {
    throw new Error("El bot de WhatsApp sigue desconectado");
  }
}

function formatPhone(number) {
  const digits = String(number || "").replace(/\D/g, "");
  return digits ? `${digits}@c.us` : "";
}

export function getBotQrStatus() {
  return {
    qrDataUrl: latestQrDataUrl,
    updatedAt: latestQrAt,
    ready: isReady,
  };
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
