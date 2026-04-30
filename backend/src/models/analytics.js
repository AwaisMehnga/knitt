const videoAnalyticsSchema = new mongoose.Schema(
  {
    videoId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Video",
      required: true,
      index: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null, // null = anonymous viewer
      index: true,
    },

    eventType: {
      type: String,
      enum: ["view", "play", "pause", "complete", "seek"],
      required: true,
      index: true,
    },

    watchTimeSec: {
      type: Number,
      default: 0,
    },

    device: {
      type: String,
      enum: ["desktop", "mobile", "tablet", "unknown"],
      default: "unknown",
    },

    browser: {
      type: String,
      default: "unknown",
    },

    country: {
      type: String,
      default: null,
    },

    ipHash: {
      type: String, // hashed for privacy compliance
      required: true,
    },

    metadata: {
      type: Object,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

// performance indexes
videoAnalyticsSchema.index({ videoId: 1, createdAt: -1 });
videoAnalyticsSchema.index({ eventType: 1, createdAt: -1 });

export const VideoAnalytics = mongoose.model(
  "VideoAnalytics",
  videoAnalyticsSchema
);