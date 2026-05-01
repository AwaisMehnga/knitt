import { User } from "../models/user.js";
import {
  getAuthCookieNames,
  verifyAccessToken,
  getCookieSettings,
} from "../utils/jwt.js";

const AUTH_RATE_LIMIT_WINDOW_MS =
  Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
const AUTH_RATE_LIMIT_MAX = Number(process.env.AUTH_RATE_LIMIT_MAX) || 25;

const rateLimitStore = new Map();

const createError = (statusCode, message, code) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) {
    error.code = code;
  }
  return error;
};

export const parseCookies = (cookieHeader = "") =>
  cookieHeader
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce((cookies, entry) => {
      const separatorIndex = entry.indexOf("=");
      if (separatorIndex === -1) {
        return cookies;
      }

      const key = entry.slice(0, separatorIndex).trim();
      const value = entry.slice(separatorIndex + 1).trim();
      cookies[key] = decodeURIComponent(value);
      return cookies;
    }, {});

export const authRateLimit = (req, res, next) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const key = `${req.path}:${ip}`;
  const currentWindowStart = Date.now() - AUTH_RATE_LIMIT_WINDOW_MS;
  const existing = rateLimitStore.get(key) || [];
  const recentHits = existing.filter((timestamp) => timestamp > currentWindowStart);

  if (recentHits.length >= AUTH_RATE_LIMIT_MAX) {
    res.setHeader(
      "Retry-After",
      String(Math.ceil(AUTH_RATE_LIMIT_WINDOW_MS / 1000))
    );
    return next(
      createError(429, "Too many authentication attempts. Try again later.")
    );
  }

  recentHits.push(Date.now());
  rateLimitStore.set(key, recentHits);
  return next();
};

export const requireSecureTransport = (req, res, next) => {
  const { refreshToken } = getCookieSettings();
  if (!refreshToken.secure) {
    return next();
  }

  const forwardedProto = req.headers["x-forwarded-proto"];
  const isSecureRequest = req.secure || forwardedProto === "https";

  if (!isSecureRequest) {
    return next(
      createError(
        400,
        "HTTPS is required for authentication endpoints in this environment."
      )
    );
  }

  return next();
};

export const requireCsrfProtection = (req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  const { csrfToken } = getAuthCookieNames();
  const csrfCookie = cookies[csrfToken];
  const csrfHeader = req.headers["x-csrf-token"];

  if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
    return next(createError(403, "CSRF validation failed."));
  }

  return next();
};

export const requireAccessToken = async (req, res, next) => {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const { accessToken: accessCookieName } = getAuthCookieNames();
    const authorizationHeader = req.headers.authorization || "";
    const [scheme, token] = authorizationHeader.split(" ");
    const accessToken = scheme === "Bearer" && token ? token : cookies[accessCookieName];

    if (!accessToken) {
      throw createError(401, "Access token is required.");
    }

    const payload = verifyAccessToken(accessToken);
    const user = await User.findById(payload.sub);

    if (!user || !user.isActive) {
      throw createError(401, "User is not authorized.");
    }

    if (user.tokenVersion !== payload.tokenVersion) {
      throw createError(401, "Access token is no longer valid.");
    }

    req.auth = {
      userId: payload.sub,
      jti: payload.jti,
      tokenVersion: payload.tokenVersion,
      user,
    };

    return next();
  } catch (error) {
    return next(error);
  }
};
