import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

import routes from "./routes/index.js";
import errorHandler from "./middlewares/error-handler.js";

const app = express();
const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.set("trust proxy", 1);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("CORS origin is not allowed."));
    },
    credentials: true,
  })
);
app.use(helmet());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
// app.use(morgan("combined"));

app.get("/", (req, res) => {
  res.status(200).json({ status: "ok", message: "Knitt backend is running" });
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy" });
});

app.use("/api/v1", routes);
app.use((req, res) => {
  res.status(404).json({
    error: "Not Found",
    message: "The requested resource was not found on this server.",
  });
});

app.use(errorHandler);

export default app;
