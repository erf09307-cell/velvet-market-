export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json; charset=utf-8"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    const respond = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: cors });

    if (!env.DB) return respond({ error: "D1 数据库未绑定" }, 500);

    const isAdmin =
      Boolean(env.ADMIN_TOKEN) &&
      request.headers.get("Authorization") === `Bearer ${env.ADMIN_TOKEN}`;

    try {
      if (url.pathname === "/api/products" && request.method === "GET") {
        const { results } = await env.DB.prepare(
          `SELECT id, title, category, price_cents, currency, image_url, description
           FROM products WHERE status = 'approved'
           ORDER BY created_at DESC`
        ).all();
        return respond({ products: results || [] });
      }

      if (url.pathname === "/api/recent-purchases" && request.method === "GET") {
        const { results } = await env.DB.prepare(
          `SELECT p.category, o.created_at FROM orders o
           JOIN products p ON p.id = o.product_id
           WHERE o.status = 'paid'
           ORDER BY o.created_at DESC LIMIT 10`
        ).all();

        return respond({
          purchases: (results || []).map(row => ({
            text: `有人购买了「${row.category}」商品`,
            createdAt: row.created_at
          }))
        });
      }

      if (url.pathname.startsWith("/api/admin/")) {
        if (!isAdmin) return respond({ error: "未授权" }, 401);

        if (url.pathname === "/api/admin/products" && request.method === "GET") {
          const { results } = await env.DB.prepare(
            "SELECT * FROM products ORDER BY created_at DESC"
          ).all();
          return respond({ products: results || [] });
        }

        if (url.pathname === "/api/admin/products" && request.method === "POST") {
          const body = await request.json();
          const title = String(body.title || "").trim().slice(0, 120);
          const category = String(body.category || "其他").trim().slice(0, 40);
          const description = String(body.description || "").trim().slice(0, 2000);
          const imageUrl = String(body.image_url || "").trim().slice(0, 1000);
          const price = Number(body.price_cents);

          if (!title || !Number.isInteger(price) || price < 0)
            return respond({ error: "商品名称或价格无效" }, 400);
          if (imageUrl && !imageUrl.startsWith("https://"))
            return respond({ error: "图片地址必须以 https:// 开头" }, 400);

          const id = crypto.randomUUID();
          await env.DB.prepare(
            `INSERT INTO products
            (id, title, category, price_cents, currency, image_url, description, status)
            VALUES (?, ?, ?, ?, 'USD', ?, ?, 'pending')`
          ).bind(id, title, category, price, imageUrl, description).run();

          return respond({ id, status: "pending" }, 201);
        }

        const statusMatch = url.pathname.match(
          /^\/api\/admin\/products\/([^/]+)\/status$/
        );
        if (statusMatch && request.method === "PATCH") {
          const body = await request.json();
          if (!["pending", "approved", "rejected"].includes(body.status))
            return respond({ error: "状态无效" }, 400);

          await env.DB.prepare(
            "UPDATE products SET status = ? WHERE id = ?"
          ).bind(body.status, statusMatch[1]).run();
          return respond({ ok: true });
        }

        const deleteMatch = url.pathname.match(/^\/api\/admin\/products\/([^/]+)$/);
        if (deleteMatch && request.method === "DELETE") {
          await env.DB.prepare(
            "DELETE FROM products WHERE id = ?"
          ).bind(deleteMatch[1]).run();
          return respond({ ok: true });
        }

        return respond({ error: "未找到后台接口" }, 404);
      }

      if (url.pathname === "/api/checkout" && request.method === "POST") {
        return respond({
          error: "支付尚未配置，请接入支付服务商的托管结账页。"
        }, 501);
      }

      return respond({ error: "未找到接口" }, 404);
    } catch {
      return respond({ error: "服务器处理失败，请检查数据库和请求内容" }, 500);
    }
  }
};
