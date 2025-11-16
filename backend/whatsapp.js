import makeWASocket, {
  useSingleFileAuthState,
  DisconnectReason
} from "@adiwajshing/baileys";
import qrcode from "qrcode";

const { state, saveState } = useSingleFileAuthState("./whatsapp_auth.json");

let sock = null;
let qrDataUrl = null;

export async function startBot() {
  try {
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrDataUrl = await qrcode.toDataURL(qr);
        console.log("🔐 Nuevo QR generado");
      }

      if (connection === "open") {
        console.log("✅ Cliente de WhatsApp conectado");
        qrDataUrl = null;
      }

      if (connection === "close") {
        const reason = lastDisconnect?.error?.output?.statusCode;

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
  }
}

export function getQrImage() {
  return qrDataUrl;
}

await startBot();
