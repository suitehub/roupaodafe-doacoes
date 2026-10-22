# Doações com Mercado Pago — backend da Vercel

Este é o pedacinho de servidor que cria o pagamento no Mercado Pago. Ele fica
**fora** do GitHub Pages (que só serve arquivos estáticos). O site chama
`POST /api/create-preference`, recebe um link de checkout e redireciona o
doador para o Mercado Pago.

```
site (GitHub Pages)  ──POST /api/create-preference──▶  Vercel (esta pasta)
                                                          │
                                                          └─▶ API Mercado Pago
doador  ◀── redireciona para o init_point ─────────────────┘
```

O Access Token fica **somente** na Vercel. Nunca coloque o token no
`index.html`/`js/main.js`.

---

## 1. O que você precisa ter em mãos

1. Conta no Mercado Pago (a mesma que vai receber as doações).
2. Credenciais em <https://www.mercadopago.com.br/developers/panel/app>:
   - aba **Credenciais de produção** → *Access token* (`APP_USR-...`)
   - aba **Credenciais de teste** → *Access token* (`TEST-...`) para testar antes.
3. Conta na [Vercel](https://vercel.com) (plano Hobby serve).

> Se o dinheiro precisa cair em uma conta diferente da sua, cadastre essa conta
> como recebedora no Mercado Pago — a API usa o token do **recebedor**.

---

## 2. Publicar o backend na Vercel (5 minutos)

> **Caminho mais rápido — repositório já pronto:** na Vercel, **Add New → Project →
> Import Git Repository** → escolha `suitehub/roupaodafe-doacoes` → Framework Preset
> **Other**, Root Directory `./`, Build Command e Output Directory **vazios** → **Deploy**.
> Depois cadastre as variáveis de ambiente (abaixo) e clique em **Redeploy**.
> A partir daí, cada `git push` na `main` publica uma nova versão sozinho.
>
> O caminho por terminal abaixo faz a mesma coisa, sem GitHub.

Abra o terminal **na raiz deste repositório**:

```powershell
cd C:\caminho\para\roupaodafe-doacoes
npx vercel login          # abre o navegador para você entrar
npx vercel                # cria o projeto (primeiro deploy, em teste)
```

Responda as perguntas assim:

| Pergunta | Resposta |
| --- | --- |
| Set up and deploy? | **Y** |
| Which scope? | sua conta |
| Link to existing project? | **N** |
| What's your project's name? | `roupaodafe-doacoes` (ou outro) |
| In which directory is your code located? | **./** (Enter) |
| Want to modify these settings? | **N** |

No fim ele mostra uma URL tipo `https://roupaodafe-doacoes.vercel.app`.

### Variáveis de ambiente

Pelo painel (mais fácil): **Vercel → projeto → Settings → Environment Variables**
e cadastre, marcando *Production*, *Preview* e *Development*:

| Nome | Valor |
| --- | --- |
| `MP_ACCESS_TOKEN` | `APP_USR-...` (produção) ou `TEST-...` |
| `SITE_URL` | `https://suitehub.github.io/roupaodafe/` |
| `ALLOWED_ORIGINS` | `https://suitehub.github.io,http://localhost:8123` |
| `MP_WEBHOOK_URL` | `https://roupaodafe-doacoes.vercel.app/api/webhook` |
| `MP_WEBHOOK_SECRET` | (opcional — só se configurar assinatura no MP) |

Ou pelo terminal:

```powershell
npx vercel env add MP_ACCESS_TOKEN production
npx vercel env add SITE_URL production
npx vercel env add ALLOWED_ORIGINS production
npx vercel env add MP_WEBHOOK_URL production
```

### Publicar de verdade

```powershell
npx vercel --prod
```

Guarde a URL de produção (`https://SEU-PROJETO.vercel.app`).

### Teste rápido (deve responder erro de método, não 404)

```powershell
curl https://SEU-PROJETO.vercel.app/api/create-preference
# {"ok":false,"error":"method_not_allowed"}
```

---

## 3. Ligar o site ao backend

Abra `js/main.js`, procure por **`MP_ENDPOINT`** (seção *DOAÇÃO — MERCADO PAGO*)
e troque o valor:

```js
var MP_ENDPOINT = "https://SEU-PROJETO.vercel.app/api/create-preference";
```

Depois publique o site normalmente (copiar para a pasta do GitHub Pages, commit
e push). Enquanto a URL estiver com `SEU-PROJETO`, o botão avisa que o pagamento
ainda não está configurado e o Pix continua funcionando.

---

## 4. Webhook (opcional, mas recomendado)

No painel do Mercado Pago → sua aplicação → **Webhooks/Notificações**:

- URL: `https://SEU-PROJETO.vercel.app/api/webhook`
- Evento: **Pagamentos**
- Se gerar uma **assinatura secreta**, copie para `MP_WEBHOOK_SECRET` na Vercel.

A função já envia `notification_url` na preferência, então normalmente o
cadastro no painel é só um reforço. Para ver as doações chegando:
**Vercel → projeto → Logs** — cada pagamento aparece assim:

```
[doacao] {"id":123456,"status":"approved","amount":50,"method":"pix",...}
```

---

## 5. Testar antes de receber dinheiro de verdade

1. Use o token `TEST-...` em `MP_ACCESS_TOKEN`.
2. Crie um **usuário de teste** em
   <https://www.mercadopago.com.br/developers/panel/test-users> (tipo *Comprador*).
3. Abra o site, escolha um valor e clique em doar.
4. Pague com o comprador de teste:
   - **Pix**: aprovado na hora (simulado).
   - **Cartão**: use um cartão de teste (ex.: `5031 4332 1540 6351`, CVV `123`,
     validade futura). A lista oficial está em
     <https://www.mercadopago.com.br/developers/pt/docs/checkout-pro/additional-content/test-cards>.
5. Confirme o retorno em `?doacao=sucesso` e o log na Vercel.
6. Troque `MP_ACCESS_TOKEN` para o token `APP_USR-...` de produção e faça um
   Pix real de R$ 5 para validar de ponta a ponta.

---

## 6. Limites e ajustes

- **Valor mínimo/máximo**: `MIN_AMOUNT` / `MAX_AMOUNT` em
  `api/create-preference.js` **e** `var MIN` / `var MAX` em `js/main.js`
  (mantenha os dois iguais).
- **Parcelamento**: `payment_methods.installments` (12 por padrão).
- **Nome na fatura**: `statement_descriptor: "ROUPAODAFE"`.
- **CORS**: só as origens de `ALLOWED_ORIGINS` podem chamar a API.

## 7. Se algo der errado

| Sintoma | Causa provável |
| --- | --- |
| `server_not_configured` | falta `MP_ACCESS_TOKEN` na Vercel (ou não fez redeploy) |
| `origin_not_allowed` | domínio do site fora de `ALLOWED_ORIGINS` |
| `mercadopago_error` + `invalid_access_token` | token errado, expirado ou de outra conta |
| botão diz "ainda não configurado" | `MP_ENDPOINT` continua com `SEU-PROJETO` |
| volta para o site sem mensagem | `SITE_URL` diferente do endereço real do site |
| Pix não aparece no checkout | conta do Mercado Pago sem chave Pix cadastrada |
