const PIP_POSITIONS = {
  "top-left": (w, h, iw, ih, p) => ({ x: p, y: p }),
  "top-center": (w, h, iw, ih, p) => ({ x: (w - iw) / 2, y: p }),
  "top-right": (w, h, iw, ih, p) => ({ x: w - iw - p, y: p }),
  "center-left": (w, h, iw, ih, p) => ({ x: p, y: (h - ih) / 2 }),
  center: (w, h, iw, ih) => ({ x: (w - iw) / 2, y: (h - ih) / 2 }),
  "center-right": (w, h, iw, ih, p) => ({ x: w - iw - p, y: (h - ih) / 2 }),
  "bottom-left": (w, h, iw, ih, p) => ({ x: p, y: h - ih - p }),
  "bottom-center": (w, h, iw, ih, p) => ({ x: (w - iw) / 2, y: h - ih - p }),
  "bottom-right": (w, h, iw, ih, p) => ({ x: w - iw - p, y: h - ih - p }),
};

const getFrameSize = (frame) => ({
  width: frame.displayWidth || frame.codedWidth || frame.width,
  height: frame.displayHeight || frame.codedHeight || frame.height,
});

const getPipLayout = ({ canvasWidth, canvasHeight, cameraFrame, options }) => {
  const camera = getFrameSize(cameraFrame);
  const shape = options.pipShape || "rectangle";
  const padding = Math.round(canvasWidth * 0.02);
  let width = Math.max(2, Math.round(canvasWidth * (options.pipSize / 100)));
  let height = width;
  const crop = { x: 0, y: 0, width: camera.width, height: camera.height };

  if (shape === "rectangle") {
    height = Math.max(2, Math.round((width * camera.height) / camera.width));
  } else {
    const minDimension = Math.min(camera.width, camera.height);
    crop.width = minDimension;
    crop.height = minDimension;
    crop.x = (camera.width - minDimension) / 2;
    crop.y = (camera.height - minDimension) / 2;
  }

  const position =
    PIP_POSITIONS[options.pipPosition || "bottom-right"] ||
    PIP_POSITIONS["bottom-right"];
  const { x, y } = position(canvasWidth, canvasHeight, width, height, padding);

  return {
    x: Math.round(x),
    y: Math.round(y),
    width,
    height,
    crop: [
      crop.x / camera.width,
      crop.y / camera.height,
      crop.width / camera.width,
      crop.height / camera.height,
    ],
  };
};

class Canvas2DCompositeRenderer {
  constructor({ width, height }) {
    this.canvas = new OffscreenCanvas(width, height);
    this.ctx = this.canvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
    });

    if (!this.ctx) throw new Error("Could not create offscreen 2D context");
  }

  draw(screenFrame, cameraFrame, options) {
    const { width, height } = this.canvas;
    this.ctx.clearRect(0, 0, width, height);
    this.ctx.drawImage(screenFrame, 0, 0, width, height);

    if (!cameraFrame || options.pipHidden) return;

    const layout = getPipLayout({
      canvasWidth: width,
      canvasHeight: height,
      cameraFrame,
      options,
    });
    const camera = getFrameSize(cameraFrame);
    const [cropX, cropY, cropWidth, cropHeight] = layout.crop;
    const radius = Math.round(
      (layout.width * Math.max(0, Number(options.pipBorderRadius || 0))) / 100
    );
    const opacity = Math.max(0, Math.min(1, (options.pipOpacity || 100) / 100));

    this.ctx.save();
    if (options.pipShape === "circle") {
      this.ctx.beginPath();
      this.ctx.arc(
        layout.x + layout.width / 2,
        layout.y + layout.height / 2,
        layout.width / 2,
        0,
        Math.PI * 2
      );
      this.ctx.clip();
    } else {
      this.roundRect(layout.x, layout.y, layout.width, layout.height, radius);
      this.ctx.clip();
    }

    this.ctx.globalAlpha = opacity;
    this.ctx.drawImage(
      cameraFrame,
      cropX * camera.width,
      cropY * camera.height,
      cropWidth * camera.width,
      cropHeight * camera.height,
      layout.x,
      layout.y,
      layout.width,
      layout.height
    );
    this.ctx.restore();

    this.ctx.save();
    this.ctx.strokeStyle = `rgba(255,255,255,${0.85 * opacity})`;
    this.ctx.lineWidth = Math.max(2, Math.round(width * 0.002));
    if (options.pipShape === "circle") {
      this.ctx.beginPath();
      this.ctx.arc(
        layout.x + layout.width / 2,
        layout.y + layout.height / 2,
        layout.width / 2,
        0,
        Math.PI * 2
      );
      this.ctx.stroke();
    } else {
      this.roundRect(layout.x, layout.y, layout.width, layout.height, radius);
      this.ctx.stroke();
    }
    this.ctx.restore();
  }

  roundRect(x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    this.ctx.beginPath();
    this.ctx.moveTo(x + r, y);
    this.ctx.lineTo(x + width - r, y);
    this.ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    this.ctx.lineTo(x + width, y + height - r);
    this.ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    this.ctx.lineTo(x + r, y + height);
    this.ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    this.ctx.lineTo(x, y + r);
    this.ctx.quadraticCurveTo(x, y, x + r, y);
    this.ctx.closePath();
  }

  destroy() {}
}

export const createCompositeRenderer = (options) =>
  new Canvas2DCompositeRenderer(options);
