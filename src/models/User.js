import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },
    passwordHash: {
      type: String,
      required: true
    },
    // Recuperación de contraseña: solo se guarda el hash del token (nunca el token en claro)
    passwordResetToken: { type: String, select: false, index: true },
    passwordResetExpires: { type: Date, select: false },
    passwordResetSentAt: { type: Date, select: false },
    // Las sesiones emitidas antes de esta fecha dejan de ser válidas
    passwordChangedAt: { type: Date }
  },
  { timestamps: true }
);

export const User = mongoose.model("User", userSchema);
