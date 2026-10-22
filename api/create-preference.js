"use strict";

/**
 * POST /api/create-preference
 *
 * Recebe { amount: number } do site, valida o valor e cria uma preferência
 * de pagamento no Mercado Pago (Checkout Pro). Devolve o init_point para o
 * navegador redirecionar o doador.
 *
 * O Access Token NUNCA sai do servidor: ele só existe aqui, como variável de
 * ambiente da Vercel (MP_ACCESS_TOKEN).
 */

const crypto = require("node:crypto");

const MP_API = "https://api.mercadopago.com";

/* Limites da doação (em reais). Se mudar aqui, mude também no js/main.js. */
const MIN_AMOUNT = 5;
const MAX_AMOUNT = 5000;

/* Proteção simples contra abuso: 10 pedidos por minuto por IP, por instância. */
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 1000;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip) || { count: 0, reset: now + RATE_WINDOW_MS };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + RATE_WINDOW_MS;
  }
  entry.count += 1;
  hits.set(ip, entry);
  if (hits.size > 5000) hits.clear();
  return entry.count > RATE_LIMIT;
}

function allowedOrigins() {
  /* domínios do projeto — sempre liberados (site novo, antigo e ambiente local) */
  const base = [
    "https://roupaodafe.com",
    "https://www.roupaodafe.com",
    "http://roupaodafe.com",
    "http://www.roupaodafe.com",
    "https://suitehub.github.io",
    "http://localhost:8123",
    "http://127.0.0.1:8123",
  ];

  /* ALLOWED_ORIGINS só acrescenta origens extras (ex.: um domínio novo) */
  const raw = (process.env.ALLOWED_ORIGINS || "").trim();
  const extra = raw
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);

  return Array.from(new Set(base.concat(extra)));
}

function siteBase(req) {
  /* endereço de volta do checkout: usa a origem da própria página (à prova de
     SITE_URL mal configurada) e, sem origem conhecida, o domínio oficial. */
  const origin = (req.headers.origin || "").trim().replace(/\/+$/, "");
  if (origin && allowedOrigins().indexOf(origin) !== -1) {
    const seguro = /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/i.test(origin)
      ? origin
      : origin.replace(/^http:/i, "https:");
    return seguro + "/";
  }

  return "https://roupaodafe.com/";
}

function applyCors(req, res) {
  const origin = (req.headers.origin || "").replace(/\/$/, "");
  if (!origin) return true;

  const allowed = allowedOrigins();
  if (allowed.indexOf(origin) === -1) return false;

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  return true;
}

function normalizeAmount(raw) {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return NaN;

  let s = raw.replace(/[^\d,.-]/g, "").trim();
  if (!s) return NaN;

  /* 1.234,56 -> 1234.56 | 1,234.56 -> 1234.56 | 50,5 -> 50.5 */
  if (s.indexOf(",") !== -1 && s.indexOf(".") !== -1) {
    s = s.lastIndexOf(",") > s.lastIndexOf(".")
      ? s.replace(/\./g, "").replace(",", ".")
      : s.replace(/,/g, "");
  } else if (s.indexOf(",") !== -1) {
    s = s.replace(",", ".");
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

module.exports = async function handler(req, res) {
  const originOk = applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }

  if (!originOk) {
    res.status(403).json({ ok: false, error: "origin_not_allowed" });
    return;
  }

  const accessToken = (process.env.MP_ACCESS_TOKEN || "").trim();
  if (!accessToken) {
    console.error("[doacao] MP_ACCESS_TOKEN não configurado na Vercel");
    res.status(500).json({ ok: false, error: "server_not_configured" });
    return;
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    (req.socket && req.socket.remoteAddress) ||
    "unknown";

  if (rateLimited(ip)) {
    res.status(429).json({ ok: false, error: "too_many_requests" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (err) {
      body = null;
    }
  }
  if (!body || typeof body !== "object") {
    res.status(400).json({ ok: false, error: "invalid_body" });
    return;
  }

  let amount = normalizeAmount(body.amount);
  if (!Number.isFinite(amount)) {
    res.status(400).json({ ok: false, error: "invalid_amount" });
    return;
  }

  amount = Math.round(amount * 100) / 100;

  if (amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
    res.status(400).json({
      ok: false,
      error: "amount_out_of_range",
      min: MIN_AMOUNT,
      max: MAX_AMOUNT,
    });
    return;
  }

  const base = siteBase(req);

  const externalReference =
    "doacao-" + Date.now() + "-" + crypto.randomUUID().slice(0, 8);

  const preference = {
    items: [
      {
        id: "doacao-roupao-da-fe",
        title: "Doação — Roupão da Fé",
        description: "Apoio às ações missionárias do projeto Roupão da Fé",
        category_id: "donations",
        quantity: 1,
        currency_id: "BRL",
        unit_price: amount,
      },
    ],
    external_reference: externalReference,
    statement_descriptor: "ROUPAODAFE",
    payment_methods: {
      installments: 12,
    },
    back_urls: {
      success: base + "?doacao=sucesso#doar",
      pending: base + "?doacao=pendente#doar",
      failure: base + "?doacao=falha#doar",
    },
    auto_return: "approved",
    metadata: {
      origem: "site-roupaodafe",
      valor: amount,
    },
  };

  if (process.env.MP_WEBHOOK_URL) {
    preference.notification_url = process.env.MP_WEBHOOK_URL;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(`${MP_API}/checkout/preferences`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": externalReference,
      },
      body: JSON.stringify(preference),
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("[doacao] erro Mercado Pago", response.status, data);
      res.status(502).json({
        ok: false,
        error: "mercadopago_error",
        detail: data.message || data.error || String(response.status),
      });
      return;
    }

    res.status(200).json({
      ok: true,
      id: data.id,
      /* com credencial de teste, manda direto para o checkout de teste */
      init_point:
        /^TEST-/.test(accessToken) && data.sandbox_init_point
          ? data.sandbox_init_point
          : data.init_point,
      sandbox_init_point: data.sandbox_init_point || null,
    });
  } catch (err) {
    console.error("[doacao] falha ao criar preferência", err);
    res.status(502).json({
      ok: false,
      error: "mercadopago_unreachable",
      detail: err && err.name === "AbortError" ? "timeout" : String(err && err.message),
    });
  } finally {
    clearTimeout(timer);
  }
};
