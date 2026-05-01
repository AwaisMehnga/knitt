import { Router } from "express";
import {
  googleAuth,
  logout,
  logoutAll,
  me,
  refreshSession,
} from "../controllers/auth.js";
import {
  authRateLimit,
  requireAccessToken,
  requireCsrfProtection,
  requireSecureTransport,
} from "../middlewares/auth.js";

const router = Router();

router.post(
  "/google",
  requireSecureTransport,
  authRateLimit,
  googleAuth
);
router.post(
  "/refresh",
  requireSecureTransport,
  authRateLimit,
  requireCsrfProtection,
  refreshSession
);
router.post(
  "/logout",
  requireSecureTransport,
  authRateLimit,
  requireCsrfProtection,
  logout
);
router.post(
  "/logout-all",
  requireSecureTransport,
  authRateLimit,
  requireAccessToken,
  logoutAll
);
router.get("/me", requireAccessToken, me);

export default router;
