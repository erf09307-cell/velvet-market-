function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Vary": "Origin"
    }
  });
}

export default {
  async fetch(request, env) {
    const requestOrigin = request.headers.get("Origin") || "";
    const allowedOrigin = env.ALLOWED_ORIGIN || "*";
    const origin = allowedOrigin === "*" ? "*" : allowedOrigin;

    if (
      allowedOrigin !== "*" &&
      requestOrigin &&
      requestOrigin !== allowedOrigin
    ) {
      return json({ error: "Origin 不允许" }, 403, origin);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Vary": "Origin"
        }
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const respond = (data, status = 200) =>
      json(data, status, origin);

    if (!env.DB) {
      return respond({ error: "Worker 尚未绑定 D1，绑定名应为 DB" }, 500);
    }

    const authorized =
      Boolean(env.ADMIN_TOKEN) &&
      request.headers.get("Authorization") === `Bearer ${env.ADMIN_TOKEN}`;

    try {
      // 前台：已审核商品
      if (path === "/api/products" && method === "GET") {
        const { results } = await env.DB.prepare(
          `SELECT id, title, category, price_cents, currency,
                  image_url, description
           FROM products
           WHERE status = 'approved'
           ORDER BY created_at DESC`
        ).all();

        return respond({ products: results || [] });
      }

      // 只显示真实标记为 paid 的订单；不返回买家身份
      if (path === "/api/recent-purchases" && method === "GET") {
        const { results } = await env.DB.prepare(
          `SELECT p.category
           FROM orders o
           JOIN products p ON p.id = o.product_id
           WHERE o.status = 'paid'
           ORDER BY o.created_at DESC
           LIMIT 10`
        ).all();

        return respond({
          purchases: (results || []).map(row => ({
            text: `有人购买了「${row.category}」商品`
          }))
        });
      }

      // 支付占位：未接入正规支付服务商之前，不发起付款
      if (path === "/api/checkout" && method === "POST") {
        return respond({
          error: "支付尚未配置。请接入支付服务商的托管结账页面。"
        }, 501);
      }

      // 后台路由均需要管理员密钥
      if (path.startsWith("/api/admin/")) {
        if (!authorized) {
          return respond({ error: "未授权，请检查管理员密钥" }, 401);
        }

        if (path === "/api/admin/products" && method === "GET") {
          const { results } = await env.DB.prepare(
            "SELECT * FROM products ORDER BY created_at DESC"
          ).all();

          return respond({ products: results || [] });
        }

        if (path === "/api/admin/products" && method === "POST") {
          const body = await request.json();

          const title = String(body.title || "").trim().slice(0, 120);
          const category = String(body.category || "其他").trim().slice(0, 40);
          const description = String(body.description || "").trim().slice(0, 2000);
          const imageUrl = String(body.image_url || "").trim().slice(0, 1000);
          const price = Number(body.price_cents);

          if (!title || !Number.isInteger(price) || price < 0) {
            return respond({ error: "商品名称或价格无效" }, 400);
          }

          if (imageUrl && !imageUrl.startsWith("https://")) {
            return respond({ error: "图片地址必须以 https:// 开头" }, 400);
          }

          const id = crypto.randomUUID();

          await env.DB.prepare(
            `INSERT INTO products
             (id, title, category, price_cents, currency,
              image_url, description, status)
             VALUES (?, ?, ?, ?, 'USD', ?, ?, 'pending')`
          ).bind(
            id, title, category, price, imageUrl, description
          ).run();

          return respond({ id, status: "pending" }, 201);
        }

        const statusMatch = path.match(
          /^\/api\/admin\/products\/([^/]+)\/status$/
        );

        if (statusMatch && method === "PATCH") {
          const body = await request.json();
          const status = String(body.status || "");

          if (!["pending", "approved", "rejected"].includes(status)) {
            return respond({ error: "状态无效" }, 400);
          }

          await env.DB.prepare(
            "UPDATE products SET status = ? WHERE id = ?"
          ).bind(status, statusMatch[1]).run();

          return respond({ ok: true });
        }

        const deleteMatch = path.match(
          /^\/api\/admin\/products\/([^/]+)$/
        );

        if (deleteMatch && method === "DELETE") {
          await env.DB.prepare(
            "DELETE FROM products WHERE id = ?"
          ).bind(deleteMatch[1]).run();

          return respond({ ok: true });
        }

        return respond({ error: "后台接口不存在" }, 404);
      }

      return respond({ error: "接口不存在" }, 404);
    } catch (error) {
      return respond({
        error: "服务器错误",
        detail: String(error?.message || error)
      }, 500);
    }
  }
};
