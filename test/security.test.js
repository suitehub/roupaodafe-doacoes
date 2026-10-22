"use strict";

/**
 * Testes de segurança das funções da Vercel (rodam sem rede).
 * Execute com: npm test
 */

const test = require("node:test");
const { beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

process.env.MP_ACCESS_TOKEN = "TEST-0000000000000000-000000-abcdefabcdefabcdefabcdefabcdefab";
process.env.MP_WEBHOOK_SECRET = "segredo-de-teste";

const createPreference = require("../api/create-preference");
const webhook = require("../api/webhook");

function mockResponse() {
  const res = {
    statusCode: 200,
    body: null,
    ended: false,
    headers: {},
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
  return res;
}

function makeReq(overrides) {
  return Object.assign(
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://roupaodafe.com",
        "x-real-ip": "203.0.113.10",
      },
      body: {},
      query: {},
    },
    overrides || {}
  );
}

const originalFetch = global.fetch;
let mpReply = null;

beforeEach(() => {
  mpReply = null;
  global.fetch = async (url) => {
    if (mpReply) return mpReply(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: "123456",
        init_point: "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=1",
        sandbox_init_point:
          "https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=1",
      }),
    };
  };
});

after(() => {
  global.fetch = originalFetch;
});

/* ---------------- create-preference ---------------- */

test("create-preference: método não permitido", async () => {
  const res = mockResponse();
  await createPreference(makeReq({ method: "GET" }), res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.body.error, "method_not_allowed");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.ok(res.headers["content-security-policy"]);
});

test("create-preference: OPTIONS de origem autorizada", async () => {
  const res = mockResponse();
  await createPreference(makeReq({ method: "OPTIONS" }), res);

  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-origin"], "https://roupaodafe.com");
  assert.ok(res.headers["vary"]);
});

test("create-preference: OPTIONS de origem desconhecida é bloqueado", async () => {
  const res = mockResponse();
  await createPreference(
    makeReq({
      method: "OPTIONS",
      headers: {
        origin: "https://invasor.example",
        "content-type": "application/json",
      },
    }),
    res
  );

  assert.equal(res.statusCode, 403);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});

test("create-preference: POST de origem desconhecida é bloqueado", async () => {
  const res = mockResponse();
  await createPreference(
    makeReq({
      headers: {
        "content-type": "application/json",
        origin: "https://invasor.example",
        "x-real-ip": "203.0.113.11",
      },
      body: { amount: 20 },
    }),
    res
  );

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "origin_not_allowed");
});

test("create-preference: content-type errado é recusado", async () => {
  const res = mockResponse();
  await createPreference(
    makeReq({
      headers: {
        "content-type": "text/plain",
        origin: "https://roupaodafe.com",
        "x-real-ip": "203.0.113.12",
      },
      body: "amount=20",
    }),
    res
  );

  assert.equal(res.statusCode, 415);
  assert.equal(res.body.error, "unsupported_media_type");
});

test("create-preference: corpo grande é recusado", async () => {
  const res = mockResponse();
  await createPreference(
    makeReq({
      headers: {
        "content-type": "application/json",
        origin: "https://roupaodafe.com",
        "content-length": "999999",
        "x-real-ip": "203.0.113.13",
      },
      body: '{"amount":20}',
    }),
    res
  );

  assert.equal(res.statusCode, 413);
});

test("create-preference: corpo malformado é recusado", async () => {
  const res = mockResponse();
  await createPreference(
    makeReq({
      headers: {
        "content-type": "application/json",
        origin: "https://roupaodafe.com",
        "x-real-ip": "203.0.113.14",
      },
      body: "{nao é json",
    }),
    res
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "invalid_json");
});

test("create-preference: valores inválidos são recusados", async () => {
  const casos = [
    { amount: "abc" },
    { amount: -10 },
    { amount: 4.99 },
    { amount: 5000.01 },
    { amount: Infinity },
    { amount: [20] },
    { amount: { valor: 20 } },
    {},
  ];

  for (const body of casos) {
    const res = mockResponse();
    await createPreference(
      makeReq({
        headers: {
          "content-type": "application/json",
          origin: "https://roupaodafe.com",
          "x-real-ip": "203.0.113.15",
        },
        body: body,
      }),
      res
    );

    assert.ok(
      res.statusCode === 400,
      "esperava 400 para " + JSON.stringify(body) + " e veio " + res.statusCode
    );
  }
});

test("create-preference: valor válido devolve só o init_point oficial", async () => {
  const res = mockResponse();
  await createPreference(
    makeReq({
      headers: {
        "content-type": "application/json",
        origin: "https://roupaodafe.com",
        "x-real-ip": "203.0.113.16",
      },
      body: { amount: 20 },
    }),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.init_point, /^https:\/\/sandbox\.mercadopago\.com\.br\//);
  assert.equal(res.body.sandbox_init_point, undefined);
});

test("create-preference: URL de checkout fora do Mercado Pago é recusada", async () => {
  mpReply = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      id: "123456",
      init_point: "https://golpe.example/checkout",
      sandbox_init_point: "https://golpe.example/checkout",
    }),
  });

  const res = mockResponse();
  await createPreference(
    makeReq({
      headers: {
        "content-type": "application/json",
        origin: "https://roupaodafe.com",
        "x-real-ip": "203.0.113.17",
      },
      body: { amount: 20 },
    }),
    res
  );

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, "checkout_unavailable");
});

test("create-preference: erro do Mercado Pago não vaza detalhes", async () => {
  mpReply = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ message: "invalid access token secret stuff" }),
  });

  const res = mockResponse();
  await createPreference(
    makeReq({
      headers: {
        "content-type": "application/json",
        origin: "https://roupaodafe.com",
        "x-real-ip": "203.0.113.18",
      },
      body: { amount: 20 },
    }),
    res
  );

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, "checkout_unavailable");
  assert.equal(res.body.detail, undefined);
  assert.ok(!JSON.stringify(res.body).includes("invalid access token"));
});

test("create-preference: rate limit por IP", async () => {
  const ip = "198.51.100.99";
  let blocked = 0;

  for (let i = 0; i < 12; i += 1) {
    const res = mockResponse();
    await createPreference(
      makeReq({
        headers: {
          "content-type": "application/json",
          origin: "https://roupaodafe.com",
          "x-real-ip": ip,
        },
        body: { amount: 20 + i },
      }),
      res
    );
    if (res.statusCode === 429) blocked += 1;
  }

  assert.ok(blocked >= 1, "esperava bloqueio por rate limit");
});

/* ---------------- webhook ---------------- */

const payment = {
  id: 987654321,
  status: "approved",
  status_detail: "accredited",
  transaction_amount: 20,
  currency_id: "BRL",
  payment_method_id: "pix",
  installments: 1,
  external_reference: "doacao-1700000000000-abcdef12",
  payer: { email: "doador@example.com" },
  date_approved: "2026-10-22T12:00:00.000-03:00",
};

test("webhook: GET responde ok", async () => {
  const res = mockResponse();
  await webhook(makeReq({ method: "GET", body: undefined }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
});

test("webhook: método não permitido", async () => {
  const res = mockResponse();
  await webhook(makeReq({ method: "DELETE" }), res);

  assert.equal(res.statusCode, 405);
});

test("webhook: assinatura inválida é recusada", async () => {
  const res = mockResponse();
  await webhook(
    makeReq({
      headers: {
        "content-type": "application/json",
        "x-real-ip": "203.0.113.30",
        "x-signature": "ts=1700000000,v1=deadbeef",
        "x-request-id": "req-1",
      },
      body: { type: "payment", data: { id: "987654321" } },
    }),
    res
  );

  assert.equal(res.statusCode, 401);
});

test("webhook: assinatura válida consulta o pagamento", async () => {
  mpReply = async () => ({ ok: true, status: 200, json: async () => payment });

  const requestId = "req-valido";
  const ts = "1700000000";
  const manifest = `id:987654321;request-id:${requestId};ts:${ts};`;
  const v1 = crypto
    .createHmac("sha256", process.env.MP_WEBHOOK_SECRET)
    .update(manifest)
    .digest("hex");

  const res = mockResponse();
  await webhook(
    makeReq({
      headers: {
        "content-type": "application/json",
        "x-real-ip": "203.0.113.31",
        "x-signature": `ts=${ts},v1=${v1}`,
        "x-request-id": requestId,
      },
      body: { type: "payment", data: { id: "987654321" } },
    }),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "approved");
});

test("webhook: id de pagamento inválido é ignorado", async () => {
  const res = mockResponse();
  await webhook(
    makeReq({
      headers: {
        "content-type": "application/json",
        "x-real-ip": "203.0.113.32",
      },
      body: { type: "payment", data: { id: "../../users/me" } },
    }),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ignored, true);
});

test("webhook: pagamento fora do padrão é ignorado", async () => {
  mpReply = async () => ({
    ok: true,
    status: 200,
    json: async () => Object.assign({}, payment, { transaction_amount: 0.5 }),
  });

  const requestId = "req-2";
  const ts = "1700000001";
  const manifest = `id:987654321;request-id:${requestId};ts:${ts};`;
  const v1 = crypto
    .createHmac("sha256", process.env.MP_WEBHOOK_SECRET)
    .update(manifest)
    .digest("hex");

  const res = mockResponse();
  await webhook(
    makeReq({
      headers: {
        "content-type": "application/json",
        "x-real-ip": "203.0.113.33",
        "x-signature": `ts=${ts},v1=${v1}`,
        "x-request-id": requestId,
      },
      body: { type: "payment", data: { id: "987654321" } },
    }),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ignored, true);
});
