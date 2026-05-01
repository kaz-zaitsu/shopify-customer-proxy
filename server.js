import express from "express";

const app = express();
app.use(express.json());

// CORS（Shopify 拡張機能のワーカーからのリクエストを許可）
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const SHOP_DOMAIN = process.env.SHOP_DOMAIN;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const API_VERSION = "2025-07";

// セッショントークン（JWT）からペイロードをデコード
function decodeToken(token) {
  try {
    const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(base64, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

// 顧客 GID を構築
function buildCustomerGid(customerId) {
  if (!customerId) return null;
  if (String(customerId).startsWith("gid://")) return customerId;
  return `gid://shopify/Customer/${customerId}`;
}

async function adminGraphQL(query, variables = {}) {
  const res = await fetch(
    `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ADMIN_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  if (!res.ok) throw new Error(`Admin API error: ${res.status}`);
  return res.json();
}

// ヘルスチェック
app.get("/", (_req, res) => res.json({ status: "ok" }));

// 顧客データ取得
app.post("/customer/get", async (req, res) => {
  try {
    const { token, customerId } = req.body;
    if (!token) return res.status(400).json({ error: "token required" });

    // トークンを検証（簡易：デコードのみ）
    const payload = decodeToken(token);
    if (!payload) return res.status(400).json({ error: "invalid token" });

    // 顧客 ID はトークンの sub または extension から受け取った ID を使用
    const rawId = payload.sub ?? customerId;
    const customerGid = buildCustomerGid(rawId);
    if (!customerGid) return res.status(400).json({ error: "customer id not found" });

    const result = await adminGraphQL(
      `query GetCustomer($id: ID!) {
        customer(id: $id) {
          firstName
          lastName
          phone
          emailMarketingConsent { marketingState }
          birthday: metafield(namespace: "facts", key: "birth_date") { value }
          gender: metafield(namespace: "custom", key: "member-gender") { value }
          kanaLastname: metafield(namespace: "custom", key: "kana-lastname") { value }
          kanaFirstname: metafield(namespace: "custom", key: "kana-firstname") { value }
        }
      }`,
      { id: customerGid }
    );

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 顧客データ更新
app.post("/customer/update", async (req, res) => {
  try {
    const { token, customerId, form } = req.body;
    if (!token || !form) return res.status(400).json({ error: "token and form required" });

    const payload = decodeToken(token);
    if (!payload) return res.status(400).json({ error: "invalid token" });

    const rawId = payload.sub ?? customerId;
    const customerGid = buildCustomerGid(rawId);
    if (!customerGid) return res.status(400).json({ error: "customer id not found" });

    // ① 標準フィールド更新（emailMarketingConsent は別ミューテーション）
    const updateResult = await adminGraphQL(
      `mutation CustomerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer { id }
          userErrors { field message }
        }
      }`,
      {
        input: {
          id: customerGid,
          firstName: form.firstName,
          lastName: form.lastName,
          phone: form.phone || null,
        },
      }
    );

    const updateErrors = updateResult.data?.customerUpdate?.userErrors ?? [];
    if (updateErrors.length) {
      return res.status(400).json({ error: updateErrors[0].message });
    }

    // ② メールマーケティング区分の更新
    const emailMarketingConsent =
      form.emailMarketing === "SUBSCRIBED"
        ? { marketingState: "SUBSCRIBED", marketingOptInLevel: "SINGLE_OPT_IN" }
        : { marketingState: form.emailMarketing };

    const emailResult = await adminGraphQL(
      `mutation CustomerEmailMarketingConsentUpdate($input: CustomerEmailMarketingConsentUpdateInput!) {
        customerEmailMarketingConsentUpdate(input: $input) {
          customer { id }
          userErrors { field message }
        }
      }`,
      {
        input: {
          customerId: customerGid,
          emailMarketingConsent,
        },
      }
    );

    const emailErrors = emailResult.data?.customerEmailMarketingConsentUpdate?.userErrors ?? [];
    if (emailErrors.length) {
      return res.status(400).json({ error: emailErrors[0].message });
    }

    // ② メタフィールド更新
    const metafields = [];
    if (form.birthday)
      metafields.push({ ownerId: customerGid, namespace: "facts", key: "birth_date", type: "date", value: form.birthday });
    if (form.gender)
      metafields.push({ ownerId: customerGid, namespace: "custom", key: "member-gender", type: "list.single_line_text_field", value: JSON.stringify([form.gender]) });
    if (form.kanaLastname)
      metafields.push({ ownerId: customerGid, namespace: "custom", key: "kana-lastname", type: "list.single_line_text_field", value: JSON.stringify([form.kanaLastname]) });
    if (form.kanaFirstname)
      metafields.push({ ownerId: customerGid, namespace: "custom", key: "kana-firstname", type: "list.single_line_text_field", value: JSON.stringify([form.kanaFirstname]) });

    if (metafields.length > 0) {
      const metaResult = await adminGraphQL(
        `mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { key namespace value }
            userErrors { field message code }
          }
        }`,
        { metafields }
      );

      const metaErrors = metaResult.data?.metafieldsSet?.userErrors ?? [];
      if (metaErrors.length) {
        return res.status(400).json({ error: metaErrors[0].message });
      }
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy server running on port ${PORT}`));
