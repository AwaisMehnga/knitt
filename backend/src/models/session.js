const sessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    refreshToken: {
      type: String,
      required: true,
      unique: true,
    },

    userAgent: {
      type: String,
      default: null,
    },

    ip: {
      type: String,
      default: null,
    },

    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },

    revokedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.model("Session", sessionSchema);