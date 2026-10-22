# Segurança — API de doações

Esta API só existe para criar preferências de checkout e registrar notificações
do Mercado Pago. Ela não guarda dados de cartão nem dados pessoais em banco.

## O que já está aplicado

- **Token apenas no servidor.** `MP_ACCESS_TOKEN` vive só nas variáveis de
  ambiente da Vercel; nunca é enviado ao navegador nem versionado.
- **CORS restrito.** Apenas os domínios oficiais do projeto (e `ALLOWED_ORIGINS`,
  se definida) recebem `Access-Control-Allow-Origin`.
- **Método, tipo e tamanho.** Só `POST`/`OPTIONS` (e `GET` de verificação no
  webhook), `application/json` e corpo de até 2 KB.
- **Validação de valor no servidor.** Mínimo R$ 5 e máximo R$ 5.000, arredondado
  em centavos — o navegador não decide o preço.
- **Rate limit.** 10 pedidos por minuto por IP (e teto global) na criação;
  120 por minuto por IP no webhook.
- **Sem vazamento de erro.** Falhas do Mercado Pago ficam no log do servidor; o
  navegador recebe apenas `checkout_unavailable`.
- **URL de checkout validada.** Só aceita `https` de
  `mercadopago.com.br` / `sandbox.mercadopago.com.br`.
- **Webhook não confiável.** A notificação nunca é usada como verdade: a função
  consulta o pagamento na API do Mercado Pago e confere id, moeda (BRL), valor
  (R$ 5–5.000) e `external_reference` (`doacao-...`).
- **Assinatura do webhook.** Quando `MP_WEBHOOK_SECRET` está definida, valida o
  HMAC `x-signature` em tempo constante.
- **Sem dados sensíveis no log.** E-mail do doador é mascarado.
- **Headers de segurança** em todas as respostas: `nosniff`, `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy`, CSP restritiva, HSTS, `no-store`,
  `noindex`.
- **Idempotência.** `X-Idempotency-Key` enviado ao Mercado Pago e deduplicação
  dos eventos do webhook.

## Limitações conhecidas

- O rate limit é em memória, por instância da Vercel. Para limite distribuído,
  use um store externo (ex.: Upstash Redis) ou o WAF do Cloudflare.
- O site (GitHub Pages) não permite cabeçalhos HTTP personalizados; a proteção
  equivalente é feita por `<meta http-equiv="Content-Security-Policy">` e
  `<meta name="referrer">` nas páginas.

## Boas práticas de operação

- Rotacione o Access Token se ele aparecer em print, chat ou log.
- Mantenha `MP_WEBHOOK_SECRET` definida (Painel do Mercado Pago → Webhooks).
- Não use a mesma conta que recebe a doação para testar o pagamento.
- Rode `npm test` antes de publicar mudanças nas funções.

## Como reportar um problema

Envie um e-mail para o responsável pelo projeto com passos para reproduzir.
Não abra issue pública com detalhes exploráveis.
