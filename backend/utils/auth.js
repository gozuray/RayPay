// backend/utils/auth.js
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "RAYPAY_SUPER_SECRET_KEY";

/**
 * Generar token JWT
 */
export function signToken(data) {
  return jwt.sign(data, JWT_SECRET, {
    expiresIn: "7d",
  });
}

/**
 * Verificar token JWT
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}
