import mongoose from "../mongoose.js";

const merchantSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true },
    wallet: { type: String, trim: true },
    destinationWallet: { type: String, trim: true },
    password: { type: String, required: true },
    role: { type: String, default: "merchant" },
    feePercent: {
      type: Number,
      min: 0,
      max: 20,
      default: null,
      set: (value) => (value === undefined ? null : value),
    },
  },
  { timestamps: true, collection: "merchants" }
);

export default mongoose.models.Merchant ||
  mongoose.model("Merchant", merchantSchema);
