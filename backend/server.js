const express = require("express");
const cors = require("cors");

const app = express();

const PORT = Number(process.env.PORT) || 5000;
const HOST = process.env.HOST || "127.0.0.1";
const DISPLAY_HOST = HOST === "0.0.0.0" ? "localhost" : HOST;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
	res.json({
		ok: true,
		service: "knitt-backend",
		message: "Server is running",
		timestamp: new Date().toISOString(),
	});
});

app.get("/health", (req, res) => {
	res.status(200).json({ status: "healthy" });
});

app.get("/api/startup", (req, res) => {
	res.json({
		startup: "success",
		env: process.env.NODE_ENV || "development",
	});
});

app.use((req, res) => {
	res.status(404).json({
		ok: false,
		error: "Route not found",
	});
});

app.use((err, req, res, next) => {
	console.error("Unhandled error:", err);
	res.status(500).json({
		ok: false,
		error: "Internal server error",
	});
});

const server = app.listen(PORT, HOST, () => {
	console.log(`Server started on http://${DISPLAY_HOST}:${PORT}`);
});

function shutdown(signal) {
	console.log(`${signal} received. Shutting down gracefully...`);
	server.close(() => {
		console.log("HTTP server closed.");
		process.exit(0);
	});

	setTimeout(() => {
		console.error("Forcing shutdown after timeout.");
		process.exit(1);
	}, 10000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
