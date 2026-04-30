const oauthAccountSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    provider: {
      type: String,
      enum: ["google"],
      required: true,
    },

    providerAccountId: {
      type: String, // Google sub / id
      required: true,
      index: true,
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

    idToken: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// prevent duplicate google account linking
oauthAccountSchema.index(
  { provider: 1, providerAccountId: 1 },
  { unique: true }
);

export const OAuthAccount = mongoose.model(
  "OAuthAccount",
  oauthAccountSchema
);