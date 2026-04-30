const videoSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },

    description: {
      type: String,
      default: "",
      maxlength: 2000,
    },

    status: {
      type: String,
      enum: ["processing", "ready", "failed"],
      default: "processing",
      index: true,
    },

    visibility: {
      type: String,
      enum: ["private", "unlisted", "public"],
      default: "unlisted",
      index: true,
    },

    driveFileId: {
      type: String,
      required: true,
      index: true,
    },

    driveUrl: {
      type: String,
      required: true,
    },

    thumbnailUrl: {
      type: String,
      default: null,
    },

    durationSec: {
      type: Number,
      default: 0,
    },

    sizeBytes: {
      type: Number,
      default: 0,
    },

    resolution: {
      width: Number,
      height: Number,
    },

    playbackUrl: {
      type: String,
      default: null,
    },

    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },

    tags: [
      {
        type: String,
        trim: true,
      },
    ],
  },
  {
    timestamps: true,
  }
);

// indexes for performance (critical for video platforms)
videoSchema.index({ userId: 1, createdAt: -1 });
videoSchema.index({ status: 1, createdAt: -1 });
videoSchema.index({ visibility: 1, createdAt: -1 });

export const Video = mongoose.model("Video", videoSchema);