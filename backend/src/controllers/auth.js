import crypto from "crypto";
import { User } from "../models/user.js";
import { OAuthAccount } from "../models/oauth-account.js";
import { Session } from "../models/session.js";
import {
  clearAuthCookies,
  createCsrfToken,
  generateAccessToken,
  generateRefreshToken,
  getAuthCookieNames,
  getRefreshTokenExpiryDate,
  getTokenMetadata,
  hashToken,
  setAuthCookies,
  verifyRefreshToken,
} from "../utils/jwt.js";
import { parseCookies } from "../middlewares/auth.js";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_TOKEN_INFO_ENDPOINT = "https://oauth2.googleapis.com/tokeninfo";

const createError = (statusCode, message, code) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) {
    error.code = code;
  }
  return error;
};

const getRequestIp = (req) =>
  req.ip ||
  req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
  req.socket?.remoteAddress ||
  null;

const buildUserResponse = (user) => ({
  id: user._id,
  email: user.email,
  name: user.name,
  avatar: user.avatar,
  role: user.role,
  isEmailVerified: user.isEmailVerified,
});

const ensureGoogleConfig = () => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw createError(
      500,
      "Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET."
    );
  }
};

const exchangeGoogleCode = async ({ code, redirectUri }) => {
  ensureGoogleConfig();

  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const payload = await response.json();
  if (!response.ok) {
    throw createError(
      401,
      payload.error_description || "Google authorization code exchange failed."
    );
  }

  return payload;
};

const verifyGoogleIdToken = async (idToken) => {
  ensureGoogleConfig();

  const response = await fetch(
    `${GOOGLE_TOKEN_INFO_ENDPOINT}?id_token=${encodeURIComponent(idToken)}`
  );
  const payload = await response.json();

  if (!response.ok) {
    throw createError(401, payload.error_description || "Google ID token is invalid.");
  }

  if (payload.aud !== GOOGLE_CLIENT_ID) {
    throw createError(401, "Google token audience does not match this application.");
  }

  if (!payload.sub || !payload.email) {
    throw createError(401, "Google profile data is incomplete.");
  }

  return payload;
};

const normalizeGoogleBoolean = (value) => value === true || value === "true";

const createSessionTokens = async ({ user, req, res }) => {
  const jti = crypto.randomUUID();
  const refreshToken = generateRefreshToken({
    userId: user._id,
    jti,
    tokenVersion: user.tokenVersion,
  });

  await Session.create({
    userId: user._id,
    refreshToken: hashToken(refreshToken),
    userAgent: req.headers["user-agent"] || null,
    ip: getRequestIp(req),
    expiresAt: getRefreshTokenExpiryDate(),
    jti,
  });

  const accessToken = generateAccessToken({
    userId: user._id,
    jti,
    tokenVersion: user.tokenVersion,
  });

  const csrfToken = createCsrfToken();
  setAuthCookies({
    res,
    accessToken,
    refreshToken,
    csrfToken,
  });

  return {
    accessToken,
    csrfToken,
  };
};

const upsertOAuthAccount = async ({
  user,
  googleProfile,
  googleTokens,
}) => {
  const existingAccount = await OAuthAccount.findOne({
    provider: "google",
    providerAccountId: googleProfile.sub,
  });
  const tokenExpiry = googleTokens.expires_in
    ? new Date(Date.now() + Number(googleTokens.expires_in) * 1000)
    : new Date(Date.now() + 60 * 60 * 1000);

  const update = {
    userId: user._id,
    provider: "google",
    providerAccountId: googleProfile.sub,
    accessToken: googleTokens.access_token || googleTokens.id_token,
    refreshToken:
      googleTokens.refresh_token ||
      existingAccount?.refreshToken ||
      `google-refresh-unavailable-${googleProfile.sub}`,
    scope: googleTokens.scope || "openid email profile",
    tokenExpiry,
    idToken: googleTokens.id_token || null,
  };

  await OAuthAccount.findOneAndUpdate(
    {
      provider: "google",
      providerAccountId: googleProfile.sub,
    },
    update,
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    }
  );
};

const findOrCreateUserFromGoogle = async ({ googleProfile, googleTokens }) => {
  let oauthAccount = await OAuthAccount.findOne({
    provider: "google",
    providerAccountId: googleProfile.sub,
  });

  let user = oauthAccount ? await User.findById(oauthAccount.userId) : null;

  if (!user) {
    user = await User.findOne({ email: googleProfile.email.toLowerCase() });
  }

  if (!user) {
    user = await User.create({
      email: googleProfile.email.toLowerCase(),
      name: googleProfile.name || googleProfile.email,
      avatar: googleProfile.picture || null,
      isEmailVerified: normalizeGoogleBoolean(googleProfile.email_verified),
      lastLoginAt: new Date(),
    });
  } else {
    user.name = googleProfile.name || user.name;
    user.avatar = googleProfile.picture || user.avatar;
    user.isEmailVerified =
      user.isEmailVerified ||
      normalizeGoogleBoolean(googleProfile.email_verified);
    user.lastLoginAt = new Date();
    await user.save();
  }

  await upsertOAuthAccount({
    user,
    googleProfile,
    googleTokens,
  });

  return user;
};

const revokeAllUserSessions = async (userId) => {
  await Session.updateMany(
    {
      userId,
      revokedAt: null,
    },
    {
      $set: {
        revokedAt: new Date(),
      },
    }
  );
};

export const googleAuth = async (req, res, next) => {
  try {
    const { code, idToken, redirectUri } = req.body;

    if (!code && !idToken) {
      throw createError(
        400,
        "Provide either a Google authorization code or Google ID token."
      );
    }

    if (code && !redirectUri) {
      throw createError(
        400,
        "redirectUri is required when exchanging a Google authorization code."
      );
    }

    const googleTokens = code
      ? await exchangeGoogleCode({ code, redirectUri })
      : {
          id_token: idToken,
          access_token: idToken,
          scope: "openid email profile",
          expires_in: 3600,
        };

    const googleProfile = await verifyGoogleIdToken(googleTokens.id_token);
    const user = await findOrCreateUserFromGoogle({
      googleProfile,
      googleTokens,
    });

    if (!user.isActive) {
      throw createError(403, "This account has been deactivated.");
    }

    const { accessToken, csrfToken } = await createSessionTokens({
      user,
      req,
      res,
    });

    return res.status(200).json({
      message: "Authenticated successfully.",
      accessToken,
      csrfToken,
      token: getTokenMetadata(),
      user: buildUserResponse(user),
    });
  } catch (error) {
    return next(error);
  }
};

export const refreshSession = async (req, res, next) => {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const { refreshToken: refreshCookieName } = getAuthCookieNames();
    const rawRefreshToken = cookies[refreshCookieName];

    if (!rawRefreshToken) {
      throw createError(401, "Refresh token is missing.");
    }

    let payload;
    try {
      payload = verifyRefreshToken(rawRefreshToken);
    } catch (error) {
      clearAuthCookies(res);
      if (error.code === "TOKEN_EXPIRED") {
        throw createError(401, "Refresh token expired. Please sign in again.");
      }
      throw error;
    }

    const user = await User.findById(payload.sub);
    if (!user || !user.isActive) {
      clearAuthCookies(res);
      throw createError(401, "Refresh token is no longer valid.");
    }

    if (user.tokenVersion !== payload.tokenVersion) {
      clearAuthCookies(res);
      throw createError(401, "Session revoked. Please sign in again.");
    }

    const session = await Session.findOne({
      userId: user._id,
      jti: payload.jti,
    });

    const refreshTokenHash = hashToken(rawRefreshToken);
    const isReuseAttempt =
      !session ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      session.refreshToken !== refreshTokenHash;

    if (isReuseAttempt) {
      await revokeAllUserSessions(user._id);
      user.tokenVersion += 1;
      await user.save();
      clearAuthCookies(res);
      throw createError(
        401,
        "Refresh token reuse detected. All sessions were revoked. Please sign in again.",
        "REFRESH_TOKEN_REUSE"
      );
    }

    session.revokedAt = new Date();
    await session.save();

    const { accessToken, csrfToken } = await createSessionTokens({
      user,
      req,
      res,
    });

    return res.status(200).json({
      message: "Session refreshed successfully.",
      accessToken,
      csrfToken,
      token: getTokenMetadata(),
      user: buildUserResponse(user),
    });
  } catch (error) {
    return next(error);
  }
};

export const logout = async (req, res, next) => {
  try {
    const { allDevices = false } = req.body || {};
    const cookies = parseCookies(req.headers.cookie);
    const { refreshToken: refreshCookieName } = getAuthCookieNames();
    const rawRefreshToken = cookies[refreshCookieName];

    if (rawRefreshToken) {
      try {
        const payload = verifyRefreshToken(rawRefreshToken);
        if (allDevices) {
          const user = await User.findById(payload.sub);
          if (user) {
            user.tokenVersion += 1;
            await user.save();
            await revokeAllUserSessions(user._id);
          }
        } else {
          await Session.updateOne(
            {
              userId: payload.sub,
              jti: payload.jti,
              revokedAt: null,
            },
            {
              $set: {
                revokedAt: new Date(),
              },
            }
          );
        }
      } catch {
        // Even if the token is already invalid, the cookies should still be cleared.
      }
    }

    clearAuthCookies(res);

    return res.status(200).json({
      message: "Logged out successfully.",
    });
  } catch (error) {
    return next(error);
  }
};

export const logoutAll = async (req, res, next) => {
  try {
    const user = req.auth.user;
    user.tokenVersion += 1;
    await user.save();
    await revokeAllUserSessions(user._id);
    clearAuthCookies(res);

    return res.status(200).json({
      message: "All sessions were revoked successfully.",
    });
  } catch (error) {
    return next(error);
  }
};

export const me = async (req, res) =>
  res.status(200).json({
    user: buildUserResponse(req.auth.user),
  });
