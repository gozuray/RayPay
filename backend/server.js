// backend/server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// ⚙️ Cargar .env desde la misma carpeta del server.js (ESM safe)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env") });

// 👉 importa después de cargar dotenv
import { connectMongo } from "./db.js";
import authRoutes from "./routes/auth.js";
import paymentsRoutes from "./routes/payments.js";

// ... resto igual



const app = express();
const PORT = process.env.PORT || 3000;

// CORS (mantengo tus orígenes)
app.use(
  cors({
    origin: [
      "http://127.0.0.1:5500",
      "http://localhost:5500",
      "http://127.0.0.1:3000",
      "http://localhost:3000",
      "https://raypay-1.onrender.com",
      "https://raypay-backend.onrender.com",
    ],
    methods: ["GET", "POST", "OPTIONS"],
    optionsSuccessStatus: 204,
  })
);
app.use(express.json());

// Conexión Mongo
await connectMongo();

// Rutas
app.use("/api/auth", authRoutes);       // /api/auth/register, /api/auth/login
app.use("/", paymentsRoutes);           // mantiene /create-payment, /confirm/:ref, /transactions, etc.

app.get("/", (_req, res) => {
  res.send("✅ RayPay Backend - Auth + Payments listo");
});

app.get("/__health", (_req, res) => {
  res.json({
    ok: true,
    now: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`✅ RayPay activo en puerto ${PORT}`);
});
