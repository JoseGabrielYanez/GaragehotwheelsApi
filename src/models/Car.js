import mongoose from "mongoose";

const carSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    name: {
      type: String,
      required: true,
      trim: true
    },
    notes: {
      type: String,
      trim: true,
      default: ""
    },
    imageUrl: {
      type: String,
      required: true
    },
    ocrText: {
      type: String,
      trim: true,
      default: ""
    }
  },
  { timestamps: true }
);

carSchema.index({ user: 1, name: "text" });

export const Car = mongoose.model("Car", carSchema);
