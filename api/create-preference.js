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
 *
 * Proteções aplicadas:
 * - apenas POST, JSON, corpo pequeno e origem autorizada (CORS)
 * - valor validado e limitado no servidor (o cliente não decide o preço)
 * - rate limit por IP e limite global por instância
 * - erros do provedor não vazam detalhes para o navegador
 * - a URL devolvida precisa ser https de um domínio oficial do Mercado Pago
 */

const crypto = require("node:crypto");
const {
  applySecurityHeaders,
  jsonError,
  allowMethods,
  clientIp,
  createRateLimiter,
  applyCors,
  readJsonBody,
  safeCheckoutUrl,
} = require("../lib/security");

const MP_API = "https://api.mercadopago.com";

/* Limites da doação (em reais). Se mudar aqui, mude também no js/main.js. */
const MIN_AMOUNT = 5;
const MAX_AMOUNT = 5000;

/* Abuso: 10 pedidos por minuto por IP e um teto global por instância. */
const perIp = createRateLimiter({ limit: 10, windowMs: 60 * 1000 });
const globalLimit = createRateLimiter({ limit: 120, windowMs: 60 * 1000 });

function allowedOrigins() {
  /* domínios oficiais do projeto — sempre liberados */
  const base = [
    "https://roupaodafe.com",
    "https://www.roupaodafe.com",
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
  /* endereço de volta do checkout: usa a origem da própria página e, sem
     origem conhecida, o domínio oficial. Sempre em https (exceto localhost). */
  const origin = String(req.headers.origin || "")
    .trim()
    .replace(/\/+$/, "");

  if (origin && allowedOrigins().indexOf(origin) !== -1) {
    const seguro = /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/i.test(origin)
      ? origin
      : origin.replace(/^http:/i, "https:");
    return seguro + "/";
  }

  return "https://roupaodafe.com/";
}

function normalizeAmount(raw) {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return NaN;

  const s = raw.replace(/[^\d,.-]/g, "").trim();
  if (!s) return NaN;

  let normalized = s;

  /* 1.234,56 -> 1234.56 | 1,234.56 -> 1234.56 | 50,5 -> 50.5 */
  if (s.indexOf(",") !== -1 && s.indexOf(".") !== -1) {
    normalized =
      s.lastIndexOf(",") > s.lastIndexOf(".")
        ? s.replace(/\./g, "").replace(",", ".")
        : s.replace(/,/g, "");
  } else if (s.indexOf(",") !== -1) {
    normalized = s.replace(",", ".");
  }

  const n = Number(normalized);
  return Number.isFinite(n) ? n : NaN;
}

module.exports = async function handler(req, res) {
  applySecurityHeaders(res);

  if (!allowMethods(req, res, ["POST", "OPTIONS"])) return;

  const allowed = allowedOrigins();
  const cors = applyCors(req, res, allowed);

  if (req.method === "OPTIONS") {
    if (!cors.ok) {
      jsonError(res, 403, "origin_not_allowed");
      return;
    }
    res.status(204).end();
    return;
  }

  if (!cors.ok) {
    jsonError(res, 403, "origin_not_allowed");
    return;
  }

  const ip = clientIp(req);
  const rl = perIp(ip);
  const gl = globalLimit("global");

  if (rl.limited || gl.limited) {
    const retryAfter = rl.limited ? rl.retryAfter : gl.retryAfter;
    res.setHeader("Retry-After", String(retryAfter));
    jsonError(res, 429, "too_many_requests");
    return;
  }

  const accessToken = (process.env.MP_ACCESS_TOKEN || "").trim();
  if (!accessToken) {
    console.error("[doacao] MP_ACCESS_TOKEN não configurado na Vercel");
    jsonError(res, 500, "server_not_configured");
    return;
  }

  const parsed = readJsonBody(req, { limit: 2048 });
  if (!parsed.ok) {
    jsonError(res, parsed.status, parsed.error);
    return;
  }

  let amount = normalizeAmount(parsed.body.amount);
  if (!Number.isFinite(amount)) {
    jsonError(res, 400, "invalid_amount");
    return;
  }

  amount = Math.round(amount * 100) / 100;

  if (amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
    jsonError(res, 400, "amount_out_of_range", {
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
      /* detalhe fica apenas no log do servidor */
      console.error(
        "[doacao] erro Mercado Pago",
        response.status,
        String(data.message || data.error || "")
      );
      jsonError(res, 502, "checkout_unavailable");
      return;
    }

    /* com credencial de teste, manda direto para o checkout de teste */
    const chosen =
      /^TEST-/.test(accessToken) && data.sandbox_init_point
        ? data.sandbox_init_point
        : data.init_point;

    const initPoint = safeCheckoutUrl(chosen);
    if (!initPoint) {
      console.error("[doacao] Mercado Pago devolveu uma URL inesperada");
      jsonError(res, 502, "checkout_unavailable");
      return;
    }

    console.log(
      "[doacao] preferência criada",
      JSON.stringify({ id: data.id, amount: amount })
    );

    res.status(200).json({ ok: true, id: data.id, init_point: initPoint });
  } catch (err) {
    console.error(
      "[doacao] falha ao criar preferência",
      err && err.name === "AbortError" ? "timeout" : String(err && err.message)
    );
    jsonError(res, 502, "checkout_unavailable");
  } finally {
    clearTimeout(timer);
  }
};
