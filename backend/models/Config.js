import mongoose from "../mongoose.js";
import { PublicKey } from "@solana/web3.js";

const configSchema = new mongoose.Schema(
  {
    globalFeePercent: {
      type: Number,
      min: 0,
      max: 20,
      default: 0,
    },
    globalFeeWallet: {
      type: String,
      default: "",
      validate: {
        validator(value) {
          if (!value) return true;
          try {
            new PublicKey(value);
            return true;
          } catch {
            return false;
          }
        },
        message: "Wallet de comisión inválida",
      },
    },
  },
  { timestamps: true, collection: "config" }
);

export default mongoose.models.Config ||
  mongoose.model("Config", configSchema);
