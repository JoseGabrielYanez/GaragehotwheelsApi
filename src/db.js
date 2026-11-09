import mongoose from "mongoose";

export async function connectDb() {
  const uri = process.env.MONGO_URI;

  if (!uri) {
    throw new Error("MONGO_URI no esta definido en server/.env");
  }

  await mongoose.connect(uri);
  console.log("MongoDB conectado");
}
