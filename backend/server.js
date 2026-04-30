import "dotenv/config";
import mongoose from "mongoose";

import app from "./src/app.js";
import connectDB from "./src/config/db.js";

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    await connectDB();

    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server is running on port ${PORT}`);
    });

    // shut down gracefully on SIGINT and SIGTERM
    const shutdown = async (signal) => {
      console.log(`Received ${signal}. Closing server...`);
      server.close(async () => {
        console.log("HTTP server closed");

        // shutdown MongoDB connection
        try {
          await mongoose.connection.close();
          console.log("MongoDB connection closed");
        } catch (error) {
          console.error("Error closing MongoDB connection:", error);
        }

        process.exit(0);
      });
    };

    // register shutdown handlers
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    console.error("Startup error:", error);
    process.exit(1);
  }
};


startServer();
