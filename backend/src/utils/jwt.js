import crypto from "crypto";

const ACCESS_TOKEN_TTL_SECONDS =
  Number(process.env.ACCESS_TOKEN_TTL_SECONDS) || 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS =
  Number(process.env.REFRESH_TOKEN_TTL_SECONDS) || 30 * 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = Number(process.env.JWT_CLOCK_SKEW_SECONDS) || 30;

const REFRESH_COOKIE_NAME =
  process.env.REFRESH_TOKEN_COOKIE_NAME || "knitt_refresh_token";
const ACCESS_COOKIE_NAME =
  process.env.ACCESS_TOKEN_COOKIE_NAME || "knitt_access_token";
const CSRF_COOKIE_NAME = process.env.CSRF_COOKIE_NAME || "knitt_csrf_token";

const ACCESS_TOKEN_SECRET =
  process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;
const REFRESH_TOKEN_SECRET =
  process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;

const base64UrlEncode = (value) =>
  Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

const base64UrlDecode = (value) => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  const padded = padding ? normalized + "=".repeat(4 - padding) : normalized;
  return Buffer.from(padded, "base64").toString("utf8");
};

const sign = (value, secret) =>
  crypto
    .createHmac("sha256", secret)
    .update(value)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

const getUnixTimestamp = () => Math.floor(Date.now() / 1000);

const ensureSecrets = () => {
  if (!ACCESS_TOKEN_SECRET || !REFRESH_TOKEN_SECRET) {
    throw new Error("JWT secrets are not configured.");
  }
};

const createToken = ({ payload, secret, expiresInSeconds }) => {
  ensureSecrets();

  const header = {
    alg: "HS256",
    typ: "JWT",
  };

  const issuedAt = getUnixTimestamp();
  const body = {
    ...payload,
    iat: issuedAt,
    nbf: issuedAt,
    exp: issuedAt + expiresInSeconds,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(body));
  const signature = sign(`${encodedHeader}.${encodedPayload}`, secret);

  return `${encodedHeader}.${encodedPayload}.${signature}`;
};

const verifyToken = (token, secret) => {
  ensureSecrets();

  if (!token || typeof token !== "string") {
    const error = new Error("Token is missing.");
    error.statusCode = 401;
    throw error;
  }

  const [headerSegment, payloadSegment, signatureSegment] = token.split(".");
  if (!headerSegment || !payloadSegment || !signatureSegment) {
    const error = new Error("Token format is invalid.");
    error.statusCode = 401;
    throw error;
  }

  const expectedSignature = sign(`${headerSegment}.${payloadSegment}`, secret);
  const providedSignature = signatureSegment;
  if (expectedSignature.length !== providedSignature.length) {
    const error = new Error("Token signature is invalid.");
    error.statusCode = 401;
    throw error;
  }

  const signaturesMatch = crypto.timingSafeEqual(
    Buffer.from(expectedSignature),
    Buffer.from(providedSignature)
  );

  if (!signaturesMatch) {
    const error = new Error("Token signature is invalid.");
    error.statusCode = 401;
    throw error;
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadSegment));
  } catch {
    const error = new Error("Token payload is invalid.");
    error.statusCode = 401;
    throw error;
  }

  const now = getUnixTimestamp();
  if (payload.nbf && now + CLOCK_SKEW_SECONDS < payload.nbf) {
    const error = new Error("Token is not active yet.");
    error.statusCode = 401;
    throw error;
  }

  if (payload.exp && now - CLOCK_SKEW_SECONDS >= payload.exp) {
    const error = new Error("Token has expired.");
    error.statusCode = 401;
    error.code = "TOKEN_EXPIRED";
    throw error;
  }

  if (!payload.sub || !payload.jti || payload.tokenVersion === undefined) {
    const error = new Error("Token payload is incomplete.");
    error.statusCode = 401;
    throw error;
  }

  return payload;
};

export const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

export const createCsrfToken = () => crypto.randomBytes(32).toString("hex");

export const generateAccessToken = ({ userId, jti, tokenVersion }) =>
  createToken({
    payload: {
      sub: String(userId),
      jti,
      tokenVersion,
    },
    secret: ACCESS_TOKEN_SECRET,
    expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
  });

export const generateRefreshToken = ({ userId, jti, tokenVersion }) =>
  createToken({
    payload: {
      sub: String(userId),
      jti,
      tokenVersion,
    },
    secret: REFRESH_TOKEN_SECRET,
    expiresInSeconds: REFRESH_TOKEN_TTL_SECONDS,
  });

export const verifyAccessToken = (token) =>
  verifyToken(token, ACCESS_TOKEN_SECRET);

export const verifyRefreshToken = (token) =>
  verifyToken(token, REFRESH_TOKEN_SECRET);

export const getRefreshTokenExpiryDate = () =>
  new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);

export const getCookieSettings = () => {
  const shouldUseSecureCookies = process.env.AUTH_COOKIE_SECURE !== "false";

  return {
    accessToken: {
      httpOnly: true,
      secure: shouldUseSecureCookies,
      sameSite: "strict",
      path: "/api/v1",
      maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000,
    },
    refreshToken: {
      httpOnly: true,
      secure: shouldUseSecureCookies,
      sameSite: "strict",
      path: "/api/v1/auth",
      maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
    },
    csrfToken: {
      httpOnly: false,
      secure: shouldUseSecureCookies,
      sameSite: "strict",
      path: "/",
      maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
    },
  };
};

export const setAuthCookies = ({ res, accessToken, refreshToken, csrfToken }) => {
  const cookieSettings = getCookieSettings();
  res.cookie(ACCESS_COOKIE_NAME, accessToken, cookieSettings.accessToken);
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, cookieSettings.refreshToken);
  res.cookie(CSRF_COOKIE_NAME, csrfToken, cookieSettings.csrfToken);
};

export const clearAuthCookies = (res) => {
  const cookieSettings = getCookieSettings();
  res.clearCookie(ACCESS_COOKIE_NAME, cookieSettings.accessToken);
  res.clearCookie(REFRESH_COOKIE_NAME, cookieSettings.refreshToken);
  res.clearCookie(CSRF_COOKIE_NAME, cookieSettings.csrfToken);
};

export const getAuthCookieNames = () => ({
  accessToken: ACCESS_COOKIE_NAME,
  refreshToken: REFRESH_COOKIE_NAME,
  csrfToken: CSRF_COOKIE_NAME,
});

export const getTokenMetadata = () => ({
  accessTokenTtlSeconds: ACCESS_TOKEN_TTL_SECONDS,
  refreshTokenTtlSeconds: REFRESH_TOKEN_TTL_SECONDS,
  clockSkewSeconds: CLOCK_SKEW_SECONDS,
  algorithm: "HS256",
});
