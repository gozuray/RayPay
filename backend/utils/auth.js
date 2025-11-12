import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET || "raypay_secret";

export function signToken(payload, opts = {}) {
  return jwt.sign(payload, SECRET, { expiresIn: "7d", ...opts });
}

export function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Token requerido" });

  try {
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded; // { id, email }
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido o expirado" });
  }
}
