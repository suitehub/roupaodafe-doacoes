"use strict";

/**
 * POST /api/webhook  (ou GET, para o teste de URL do painel)
 *
 * O Mercado Pago chama esta rota sempre que um pagamento muda de status.
 * A função consulta o pagamento na API do Mercado Pago e registra no log da
 * Vercel (Dashboard → projeto → Logs) o valor, o status e a referência.
 *
 * Não guarda dados em banco: serve para você acompanhar as doações e conferir
 * se está tudo chegando. Se um dia quiser enviar e-mail/planilha, é aqui.
 */

const crypto = require("node:crypto");

const MP_API = "https://api.mercadopago.com";

function verifySignature(req, paymentId) {
  const secret = (process.env.MP_WEBHOOK_SECRET || "").trim();
  if (!secret) return true; // verificação opcional

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

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(parts.v1), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (err) {
      body = {};
    }
  }
  body = body || {};

  const query = req.query || {};
  const type =
    body.type ||
    body.topic ||
    query.type ||
    query.topic ||
    "";

  const paymentId =
    (body.data && body.data.id) ||
    query["data.id"] ||
    query.id ||
    "";

  /* notificações que não são de pagamento: responde 200 e ignora */
  if (type !== "payment" || !paymentId) {
    res.status(200).json({ ok: true, ignored: true });
    return;
  }

  if (!verifySignature(req, paymentId)) {
    console.warn("[doacao] webhook com assinatura inválida", paymentId);
    res.status(401).json({ ok: false, error: "invalid_signature" });
    return;
  }

  const accessToken = (process.env.MP_ACCESS_TOKEN || "").trim();
  if (!accessToken) {
    res.status(200).json({ ok: true, ignored: true, reason: "no_token" });
    return;
  }

  try {
    const response = await fetch(`${MP_API}/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const payment = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("[doacao] webhook: erro ao consultar pagamento", paymentId, response.status);
      res.status(200).json({ ok: true, error: "lookup_failed" });
      return;
    }

    console.log(
      "[doacao]",
      JSON.stringify({
        id: payment.id,
        status: payment.status,
        status_detail: payment.status_detail,
        amount: payment.transaction_amount,
        currency: payment.currency_id,
        method: payment.payment_method_id,
        installments: payment.installments,
        external_reference: payment.external_reference,
        payer_email: payment.payer && payment.payer.email,
        date_approved: payment.date_approved,
      })
    );

    res.status(200).json({ ok: true, status: payment.status });
  } catch (err) {
    console.error("[doacao] webhook: falha de rede", err);
    res.status(200).json({ ok: true, error: "network" });
  }
};
