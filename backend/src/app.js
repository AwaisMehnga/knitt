import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

import routes from "./routes/index.js";
import errorHandler from "./middlewares/error-handler.js";

const app = express();

app.use(cors());
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

app.use("/api", routes);
app.use((req, res) => {
  res.status(404).json({
    error: "Not Found",
    message: "The requested resource was not found on this server.",
  });
});

app.use(errorHandler);

export default app;
