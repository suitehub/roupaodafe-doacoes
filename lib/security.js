"use strict";

/**
 * Utilitários de segurança compartilhados pelas funções da Vercel.
 *
 * - headers de segurança em todas as respostas
 * - CORS restrito por lista de origens
 * - limite de tamanho e validação de JSON
 * - rate limit em memória (por instância)
 * - validação da URL de checkout devolvida pelo Mercado Pago
 */

const crypto = require("node:crypto");

const MAX_BODY_BYTES = 4096;

function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Permissions-Policy",
    "accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), " +
      "geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), " +
      "picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), usb=(), " +
      "xr-spatial-tracking=()"
  );
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  );
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
}

function jsonError(res, status, error, extra) {
  const body = Object.assign({ ok: false, error: error }, extra || {});
  res.status(status).json(body);
}

function allowMethods(req, res, methods) {
  const method = String(req.method || "").toUpperCase();
  if (methods.indexOf(method) !== -1) return true;

  res.setHeader("Allow", methods.join(", "));
  jsonError(res, 405, "method_not_allowed");
  return false;
}

function clientIp(req) {
  const real = String(req.headers["x-real-ip"] || "").trim();
  if (real) return real;

  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  if (forwarded) return forwarded;

  return (req.socket && req.socket.remoteAddress) || "unknown";
}

/**
 * Limite simples em memória — protege contra rajadas dentro de uma instância.
 * Para limite distribuído seria necessário um store externo (Upstash/Redis).
 */
function createRateLimiter(options) {
  const limit = options.limit;
  const windowMs = options.windowMs;
  const maxKeys = options.maxKeys || 10000;
  const hits = new Map();

  return function hit(key) {
    const now = Date.now();
    let entry = hits.get(key);

    if (!entry || now > entry.reset) {
      entry = { count: 0, reset: now + windowMs };
    }

    entry.count += 1;
    hits.set(key, entry);

    if (hits.size > maxKeys) {
      for (const [k, v] of hits) {
        if (v.reset < now) hits.delete(k);
      }
      if (hits.size > maxKeys) hits.clear();
    }

    return {
      limited: entry.count > limit,
      remaining: Math.max(0, limit - entry.count),
      retryAfter: Math.max(1, Math.ceil((entry.reset - now) / 1000)),
    };
  };
}

function readOrigin(req) {
  return String(req.headers.origin || "")
    .trim()
    .replace(/\/+$/, "");
}

/**
 * Aplica os cabeçalhos CORS somente se a origem estiver na lista.
 * Retorna { ok, origin, allowed }.
 */
function applyCors(req, res, allowedOrigins) {
  const origin = readOrigin(req);
  if (!origin) return { ok: true, origin: "", allowed: [] };

  res.setHeader("Vary", "Origin");

  if (allowedOrigins.indexOf(origin) === -1) {
    return { ok: false, origin: origin, allowed: [] };
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");

  return { ok: true, origin: origin, allowed: allowedOrigins };
}

/**
 * Lê e valida o corpo JSON.
 * Retorna { ok: true, body } ou { ok: false, status, error }.
 */
function readJsonBody(req, options) {
  const opts = options || {};
  const limit = opts.limit || MAX_BODY_BYTES;
  const allowForm = opts.allowForm === true;

  const contentType = String(req.headers["content-type"] || "")
    .split(";")[0]
    .trim()
    .toLowerCase();

  const isJson = contentType === "application/json";
  const isForm =
    allowForm &&
    (contentType === "application/x-www-form-urlencoded" ||
      contentType === "text/plain");

  if (!isJson && !isForm) {
    return { ok: false, status: 415, error: "unsupported_media_type" };
  }

  const declared = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declared) && declared > limit) {
    return { ok: false, status: 413, error: "payload_too_large" };
  }

  let body = req.body;

  if (Buffer.isBuffer(body)) body = body.toString("utf8");

  if (typeof body === "string") {
    if (Buffer.byteLength(body, "utf8") > limit) {
      return { ok: false, status: 413, error: "payload_too_large" };
    }

    if (isForm) {
      body = Object.fromEntries(new URLSearchParams(body));
    } else {
      try {
        body = JSON.parse(body);
      } catch (err) {
        return { ok: false, status: 400, error: "invalid_json" };
      }
    }
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "invalid_body" };
  }

  if (Buffer.byteLength(JSON.stringify(body), "utf8") > limit) {
    return { ok: false, status: 413, error: "payload_too_large" };
  }

  return { ok: true, body: body };
}

/**
 * Só aceita links https do Mercado Pago (evita redirecionar para outro site).
 */
function safeCheckoutUrl(raw) {
  try {
    const url = new URL(String(raw || ""));
    if (url.protocol !== "https:") return "";

    const host = url.hostname.toLowerCase();
    const allowed =
      host === "mercadopago.com.br" ||
      host === "www.mercadopago.com.br" ||
      host === "sandbox.mercadopago.com.br";

    return allowed ? url.toString() : "";
  } catch (err) {
    return "";
  }
}

function onlyDigits(value, maxLength) {
  const s = String(value == null ? "" : value).trim();
  if (!/^\d+$/.test(s)) return "";
  if (s.length > (maxLength || 20)) return "";
  return s;
}

function maskEmail(email) {
  const s = String(email || "").trim();
  const at = s.indexOf("@");
  if (at < 1) return "";

  const user = s.slice(0, at);
  const domain = s.slice(at + 1);
  const visible = user.slice(0, Math.min(2, user.length));
  return visible + "***@" + domain;
}

function timingSafeEqualHex(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

module.exports = {
  MAX_BODY_BYTES,
  applySecurityHeaders,
  jsonError,
  allowMethods,
  clientIp,
  createRateLimiter,
  applyCors,
  readOrigin,
  readJsonBody,
  safeCheckoutUrl,
  onlyDigits,
  maskEmail,
  timingSafeEqualHex,
};
