// backend/server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import { connectMongo } from "./db.js";
import { connectMongoose } from "./mongoose.js";
import authRoutes from "./routes/auth.js";
import paymentsRoutes from "./routes/payments.js";
import adminRoutes from "./routes/admin.js";

// ======================
//  Cargar .env
// ======================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, ".env") });

// ======================
//  Crear app
// ======================
const app = express();
const PORT = process.env.PORT || 3000;

// ======================
//  CORS
// ======================
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204,
  })
);

app.use(express.json());

// ======================
//  Conexión a Mongo
// ======================
await Promise.all([connectMongo(), connectMongoose()]);

// ======================
//  Rutas
// ======================

// Auth: /api/auth/register, /api/auth/login
app.use("/api/auth", authRoutes);

// Pagos, historial, etc. (mantienes tus rutas previas)
app.use("/", paymentsRoutes);

// Admin: /api/admin/merchants, /api/admin/create, /api/admin/merchant/:id
app.use("/api/admin", adminRoutes);

// Healthcheck simple
app.get("/", (_req, res) => {
  res.send("✅ RayPay Backend - Auth + Payments + Admin listo");
});

app.get("/__health", (_req, res) => {
  res.json({
    ok: true,
    now: new Date().toISOString(),
  });
});

// ======================
//  Arrancar servidor
// ======================
app.listen(PORT, () => {
  console.log(`✅ RayPay activo en puerto ${PORT}`);
});
