"use strict";

/**
 * POST /api/webhook  (ou GET, para o teste de URL do painel)
 *
 * O Mercado Pago chama esta rota sempre que um pagamento muda de status.
 * A função NUNCA confia no conteúdo da notificação: ela consulta o pagamento
 * na API do Mercado Pago com o Access Token do servidor e confere valor,
 * moeda e referência antes de registrar.
 *
 * Proteções aplicadas:
 * - assinatura HMAC do Mercado Pago (quando MP_WEBHOOK_SECRET está definida)
 * - id do pagamento só com dígitos (nada de URL arbitrária)
 * - rate limit e limite de corpo
 * - consulta ao provedor com timeout
 * - log sem dados sensíveis (e-mail mascarado)
 */

const crypto = require("node:crypto");
const {
  applySecurityHeaders,
  jsonError,
  allowMethods,
  clientIp,
  createRateLimiter,
  readJsonBody,
  onlyDigits,
  maskEmail,
  timingSafeEqualHex,
} = require("../lib/security");

const MP_API = "https://api.mercadopago.com";

const MIN_AMOUNT = 5;
const MAX_AMOUNT = 5000;

const rateLimit = createRateLimiter({ limit: 120, windowMs: 60 * 1000 });
const processed = new Set();
let warnedNoSecret = false;

function verifySignature(req, paymentId) {
  const secret = (process.env.MP_WEBHOOK_SECRET || "").trim();

  if (!secret) {
    if (!warnedNoSecret) {
      warnedNoSecret = true;
      console.warn(
        "[doacao] MP_WEBHOOK_SECRET não configurado: a assinatura do webhook não será verificada"
      );
    }
    return true;
  }

  const signature = req.headers["x-signature"];
  const requestId = req.headers["x-request-id"];
  if (!signature || !requestId) return false;

  const parts = String(signature)
    .split(",")
    .map((p) => p.trim())
    .reduce((acc, part) => {
      const i = part.indexOf("=");
      if (i > 0) acc[part.slice(0, i)] = part.slice(i + 1);
      return acc;
    }, {});

  if (!parts.ts || !parts.v1) return false;

  const manifest = `id:${paymentId};request-id:${requestId};ts:${parts.ts};`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(manifest)
    .digest("hex");

  return timingSafeEqualHex(expected, parts.v1);
}

module.exports = async function handler(req, res) {
  applySecurityHeaders(res);

  if (!allowMethods(req, res, ["GET", "POST"])) return;

  if (req.method === "GET") {
    res.status(200).json({ ok: true });
    return;
  }

  const rl = rateLimit(clientIp(req));
  if (rl.limited) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    jsonError(res, 429, "too_many_requests");
    return;
  }

  const parsed = readJsonBody(req, { limit: 4096, allowForm: true });
  if (!parsed.ok) {
    jsonError(res, parsed.status, parsed.error);
    return;
  }

  const body = parsed.body;
  const query = req.query || {};

  const type = String(body.type || body.topic || query.type || query.topic || "");
  const rawId =
    (body.data && body.data.id) || query["data.id"] || query.id || "";
  const paymentId = onlyDigits(rawId, 20);

  /* notificações que não são de pagamento: responde 200 e ignora */
  if (type !== "payment" || !paymentId) {
    res.status(200).json({ ok: true, ignored: true });
    return;
  }

  if (!verifySignature(req, paymentId)) {
    console.warn("[doacao] webhook com assinatura inválida", paymentId);
    jsonError(res, 401, "invalid_signature");
    return;
  }

  const accessToken = (process.env.MP_ACCESS_TOKEN || "").trim();
  if (!accessToken) {
    res.status(200).json({ ok: true, ignored: true, reason: "no_token" });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(
      `${MP_API}/v1/payments/${encodeURIComponent(paymentId)}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      }
    );

    const payment = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(
        "[doacao] webhook: erro ao consultar pagamento",
        paymentId,
        response.status
      );
      res.status(200).json({ ok: true, error: "lookup_failed" });
      return;
    }

    /* o pagamento consultado tem que ser o mesmo da notificação */
    if (String(payment.id) !== paymentId) {
      console.warn("[doacao] webhook: id divergente", paymentId);
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const amount = Number(payment.transaction_amount);
    const currency = String(payment.currency_id || "");
    const reference = String(payment.external_reference || "");
    const status = String(payment.status || "");

    const valorOk = Number.isFinite(amount) && amount >= MIN_AMOUNT && amount <= MAX_AMOUNT;
    const moedaOk = currency === "BRL";
    const referenciaOk = reference.indexOf("doacao-") === 0;

    if (!valorOk || !moedaOk || !referenciaOk) {
      console.warn(
        "[doacao] webhook: pagamento fora do padrão",
        JSON.stringify({
          id: payment.id,
          status: status,
          amount: Number.isFinite(amount) ? amount : null,
          currency: currency,
          referencia_ok: referenciaOk,
        })
      );
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    /* evita registrar o mesmo evento duas vezes (o MP reenvia notificações) */
    const dedupeKey = `${paymentId}:${status}`;
    if (!processed.has(dedupeKey)) {
      processed.add(dedupeKey);
      if (processed.size > 2000) processed.clear();

      console.log(
        "[doacao]",
        JSON.stringify({
          id: payment.id,
          status: status,
          status_detail: payment.status_detail,
          amount: amount,
          currency: currency,
          method: payment.payment_method_id,
          installments: payment.installments,
          external_reference: reference,
          payer_email: maskEmail(payment.payer && payment.payer.email),
          date_approved: payment.date_approved,
        })
      );
    }

    res.status(200).json({ ok: true, status: status });
  } catch (err) {
    console.error(
      "[doacao] webhook: falha de rede",
      err && err.name === "AbortError" ? "timeout" : String(err && err.message)
    );
    res.status(200).json({ ok: true, error: "network" });
  } finally {
    clearTimeout(timer);
  }
};
