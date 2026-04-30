const driveConnectionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },

    provider: {
      type: String,
      enum: ["google_drive"],
      default: "google_drive",
    },

    accessToken: {
      type: String,
      required: true,
    },

    refreshToken: {
      type: String,
      required: true,
    },

    scope: {
      type: String,
      required: true,
    },

    tokenExpiry: {
      type: Date,
      required: true,
    },

    driveEmail: {
      type: String,
      required: true,
    },

    driveRootFolderId: {
      type: String, // optional but useful for organization
      default: null,
    },

    isConnected: {
      type: Boolean,
      default: true,
      index: true,
    },

    lastSyncedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

export const DriveConnection = mongoose.model(
  "DriveConnection",
  driveConnectionSchema
);