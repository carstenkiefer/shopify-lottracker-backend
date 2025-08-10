// --- Imports ---
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;
const { SHOPIFY_API_KEY, SHOPIFY_API_SECRET, DATABASE_URL } = process.env;

// --- DB ---
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ======================================================================
// 1) WEBHOOK: orders/create  (raw body + HMAC-Verify)
// ======================================================================
// ACHTUNG: webhook-Route COMES BEFORE app.use(express.json())
app.post('/webhooks/orders/create', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const hmacHeader = req.get('x-shopify-hmac-sha256') || '';
    const shopDomain = req.get('x-shopify-shop-domain'); // z.B. myshop.myshopify.com
    const topic = req.get('x-shopify-topic'); // "orders/create"

    if (!shopDomain || !hmacHeader) {
      return res.status(400).send('Missing headers');
    }
    if (topic && topic.toLowerCase() !== 'orders/create') {
      // Optional: Nur orders/create akzeptieren
      return res.status(200).send('Ignored topic');
    }

    // HMAC prüfen
    const digest = crypto
      .createHmac('sha256', SHOPIFY_API_SECRET)
      .update(req.body, 'utf8')
      .digest('base64');

    // timing-safe Vergleich
    const safeEqual =
      hmacHeader.length === digest.length &&
      crypto.timingSafeEqual(Buffer.from(hmacHeader, 'base64'), Buffer.from(digest, 'base64'));

    if (!safeEqual) {
      return res.status(401).send('Invalid HMAC');
    }

    // Payload parsen (nach HMAC!)
    const order = JSON.parse(req.body.toString('utf8'));

    // Mapping Order → internes Format für processOrder()
    const shopifyOrderId = String(order.id);
    const customerName =
      order?.customer ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() : (order?.email || 'Unbekannt');
    const orderDate = order.created_at || new Date().toISOString();

    // Line Items: REST liefert numeric IDs -> wir formen GraphQL GIDs: gid://shopify/Product/{product_id}
    const lineItems = (order.line_items || [])
      .filter((li) => li.product_id) // nur Items mit Produktbezug
      .map((li) => ({
        shopifyProductId: `gid://shopify/Product/${li.product_id}`,
        productName: li.title || li.name || '',
        productSku: li.sku || '',
        quantity: parseInt(li.quantity, 10) || 0,
      }))
      .filter((li) => li.quantity > 0);

    if (!lineItems.length) {
      // Nichts zu verbuchen → trotzdem 200, damit Shopify nicht retried
      return res.status(200).send('No usable line items');
    }

    // Gleiche Logik wie bei /api/orders
    await processOrder(shopDomain, {
      shopifyOrderId,
      customerName,
      orderDate,
      lineItems,
    });

    // Shopify will 200 OK schnell zurück
    return res.status(200).send('Processed');
  } catch (err) {
    console.error('Webhook orders/create error:', err?.response?.data || err.message);
    // 200 zurückgeben, um Retries zu vermeiden – alternativ 500, wenn du bewusst Retries willst
    return res.status(200).send('OK');
  }
});

// ======================================================================
// 2) Globale Middleware (nach dem Webhook!)
// ======================================================================
app.use(cors());
app.use(express.json());

// ======================================================================
// 3) Helper: Shopify Admin GraphQL
// ======================================================================
const makeShopifyApiCall = async (shop, query, variables = {}) => {
  const dbResult = await pool.query('SELECT access_token FROM installations WHERE shop = $1 LIMIT 1', [shop]);
  if (dbResult.rows.length === 0) {
    throw new Error(`Keine Installation für den Shop ${shop} gefunden.`);
  }
  const accessToken = dbResult.rows[0].access_token;
  const apiUrl = `https://${shop}/admin/api/2023-10/graphql.json`;

  const response = await axios.post(
    apiUrl,
    { query, variables },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      timeout: 15000,
    }
  );
  return response.data;
};

// ======================================================================
// 4) Order-Verarbeitung extrahiert -> von Webhook & /api/orders nutzbar
// ======================================================================
async function processOrder(shop, payload) {
  const { shopifyOrderId, customerName, orderDate, lineItems } = payload;

  if (!shopifyOrderId || !Array.isArray(lineItems) || lineItems.length === 0) {
    throw new Error('Invalid order payload');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Bestellung anlegen
    const orderResult = await client.query(
      `INSERT INTO orders (shopify_order_id, customer_name, order_date)
       VALUES ($1, $2, $3)
       ON CONFLICT (shopify_order_id) DO NOTHING
       RETURNING id;`,
      [shopifyOrderId, customerName || null, orderDate || new Date().toISOString()]
    );

    // Falls Order bereits existierte (ON CONFLICT), hole id
    let newOrderId;
    if (orderResult.rows.length) {
      newOrderId = orderResult.rows[0].id;
    } else {
      const existing = await client.query('SELECT id FROM orders WHERE shopify_order_id = $1', [shopifyOrderId]);
      newOrderId = existing.rows[0].id;
    }

    for (const item of lineItems) {
      let quantityToFulfill = item.quantity;

      // Produkt-ID sicherstellen oder neu anlegen
      let productInfo = await client.query('SELECT id, sku FROM products WHERE shopify_product_id = $1', [item.shopifyProductId]);
      if (productInfo.rows.length === 0) {
        const ins = await client.query(
          `INSERT INTO products (shopify_product_id, name, sku) VALUES ($1, $2, $3) RETURNING id, sku;`,
          [item.shopifyProductId, item.productName || null, item.productSku || null]
        );
        productInfo = ins;
      }
      const internalProductId = productInfo.rows[0].id;
      const productSku = productInfo.rows[0].sku;

      // FIFO: vorhandene Chargen mit Restmenge
      const batchesResult = await client.query(
        'SELECT id, quantity FROM batches WHERE product_id = $1 AND quantity > 0 ORDER BY expiry_date ASC NULLS LAST, created_at ASC',
        [internalProductId]
      );

      for (const batch of batchesResult.rows) {
        if (quantityToFulfill <= 0) break;
        const pick = Math.min(quantityToFulfill, batch.quantity);
        await client.query('UPDATE batches SET quantity = quantity - $1 WHERE id = $2', [pick, batch.id]);
        await client.query(
          'INSERT INTO order_line_items (order_id, product_id, batch_id, quantity) VALUES ($1, $2, $3, $4)',
          [newOrderId, internalProductId, batch.id, pick]
        );
        quantityToFulfill -= pick;
      }

      if (quantityToFulfill > 0) {
        // Metafelder vom Produkt holen
        const query = `
          query ($id: ID!) {
            product(id: $id) {
              shelfLife: metafield(namespace: "custom", key: "default_shelf_life_days") { value }
              batchQuantity: metafield(namespace: "custom", key: "default_batch_quantity") { value }
            }
          }
        `;
        const apiResponse = await makeShopifyApiCall(shop, query, { id: item.shopifyProductId });
        const shelfLifeDays = apiResponse?.data?.product?.shelfLife?.value;
        const defaultBatchQuantity = apiResponse?.data?.product?.batchQuantity?.value;

        const now = new Date();
        const newBatchNumber = `${productSku || 'PROD'}-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
          now.getDate()
        ).padStart(2, '0')}-${now.getTime()}`;

        let newExpiryDate = null;
        if (shelfLifeDays) {
          now.setDate(now.getDate() + parseInt(shelfLifeDays, 10));
          newExpiryDate = now.toISOString().split('T')[0];
        }

        const newBatchQty = defaultBatchQuantity ? parseInt(defaultBatchQuantity, 10) : 100;

        const newBatch = await client.query(
          'INSERT INTO batches (product_id, batch_number, expiry_date, quantity) VALUES ($1, $2, $3, $4) RETURNING id',
          [internalProductId, newBatchNumber, newExpiryDate, newBatchQty]
        );
        const newBatchId = newBatch.rows[0].id;

        const pickRest = Math.min(quantityToFulfill, newBatchQty);
        await client.query('UPDATE batches SET quantity = quantity - $1 WHERE id = $2', [pickRest, newBatchId]);
        await client.query(
          'INSERT INTO order_line_items (order_id, product_id, batch_id, quantity) VALUES ($1, $2, $3, $4)',
          [newOrderId, internalProductId, newBatchId, pickRest]
        );

        quantityToFulfill -= pickRest;
      }

      // Falls quantityToFulfill > 0: Backorder/Rest ungedeckt – hier bewusst ignoriert oder loggen
      if (quantityToFulfill > 0) {
        console.warn('Ungedeckte Menge nach Neuanlage von Chargen:', { product: item.shopifyProductId, rest: quantityToFulfill });
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ======================================================================
// 5) Geschützte API (App Bridge JWT) – GraphQL-Proxy & CRUD
// ======================================================================
const apiRouter = express.Router();

// JWT-Check von App Bridge (Frontend)
const verifyShopifySession = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).send({ message: 'Unauthorized: No token provided.' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.decode(token);
    if (!decoded || !decoded.dest) throw new Error('Invalid token');
    const hostname = new URL(decoded.dest).hostname; // myshop.myshopify.com
    req.shop = hostname;
    next();
  } catch (error) {
    return res.status(401).send({ message: 'Unauthorized: Invalid token.' });
  }
};
apiRouter.use(verifyShopifySession);

// GraphQL-Proxy
apiRouter.post('/graphql', async (req, res) => {
  try {
    const { query, variables } = req.body || {};
    if (!query) return res.status(400).json({ message: 'Missing GraphQL query.' });
    const data = await makeShopifyApiCall(req.shop, query, variables || {});
    return res.status(200).json(data);
  } catch (err) {
    if (err.response) {
      const status = err.response.status || 500;
      return res.status(status).json(
        typeof err.response.data === 'object' ? err.response.data : { message: 'Upstream error', data: err.response.data }
      );
    }
    console.error('GraphQL proxy error:', err.message);
    return res.status(500).json({ message: 'GraphQL proxy failed', error: err.message });
  }
});

// POST /api/batches (bestehend – nutzt ggf. Metafeld shelf life)
apiRouter.post('/batches', async (req, res) => {
  const { shopifyProductId, productName, productSku, batchNumber, expiryDate, quantity } = req.body;
  const { shop } = req;

  if (!shopifyProductId || !batchNumber || !quantity) {
    return res.status(400).json({ message: 'Shopify Produkt-ID, Chargennummer und Menge sind erforderlich.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let productResult = await client.query('SELECT id FROM products WHERE shopify_product_id = $1', [shopifyProductId]);
    let internalProductId;

    if (productResult.rows.length > 0) {
      internalProductId = productResult.rows[0].id;
    } else {
      const ins = await client.query(
        `INSERT INTO products (shopify_product_id, name, sku) VALUES ($1, $2, $3) RETURNING id;`,
        [shopifyProductId, productName || null, productSku || null]
      );
      internalProductId = ins.rows[0].id;
    }

    let finalExpiryDate = expiryDate || null;
    if (!finalExpiryDate) {
      const query = `
        query ($id: ID!) {
          product(id: $id) {
            shelfLife: metafield(namespace: "custom", key: "default_shelf_life_days") { value }
          }
        }
      `;
      const apiResponse = await makeShopifyApiCall(shop, query, { id: shopifyProductId });
      const shelfLifeDays = apiResponse?.data?.product?.shelfLife?.value;
      if (shelfLifeDays) {
        const today = new Date();
        today.setDate(today.getDate() + parseInt(shelfLifeDays, 10));
        finalExpiryDate = today.toISOString().split('T')[0];
      }
    }

    const insBatch = await client.query(
      `INSERT INTO batches (product_id, batch_number, expiry_date, quantity) VALUES ($1, $2, $3, $4) RETURNING *;`,
      [internalProductId, batchNumber, finalExpiryDate, parseInt(quantity, 10)]
    );

    await client.query('COMMIT');
    res.status(201).json({ message: 'Charge erfolgreich erstellt.', batch: insBatch.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Fehler beim Erstellen der Charge:', error?.response?.data || error.message);
    if (error.code === '23505') {
      return res.status(409).json({ message: 'Diese Chargennummer existiert bereits.' });
    }
    res.status(500).json({ message: 'Interner Serverfehler' });
  } finally {
    client.release();
  }
});

// GET /api/batches – inkl. shopify_product_id
apiRouter.get('/batches', async (req, res) => {
  try {
    const q = `
      SELECT
        b.id,
        b.batch_number,
        b.expiry_date,
        b.quantity,
        b.created_at,
        p.name  AS product_name,
        p.sku   AS sku,
        p.shopify_product_id
      FROM batches b
      JOIN products p ON p.id = b.product_id
      ORDER BY b.created_at DESC, b.id DESC;
    `;
    const { rows } = await pool.query(q);
    return res.json(rows);
  } catch (error) {
    console.error('Fehler beim Laden der Chargen:', error);
    return res.status(500).json({ message: 'Interner Serverfehler' });
  }
});

// PUT /api/batches/:id
apiRouter.put('/batches/:id', async (req, res) => {
  const { id } = req.params;
  const { expiryDate, quantity } = req.body || {};

  try {
    const q = `
      UPDATE batches
         SET expiry_date = $1,
             quantity    = $2
       WHERE id = $3
   RETURNING *;
    `;
    const { rows } = await pool.query(q, [expiryDate || null, Number.parseInt(quantity, 10) || 0, id]);
    if (!rows.length) return res.status(404).json({ message: 'Charge nicht gefunden.' });
    return res.json({ message: 'Charge aktualisiert.', batch: rows[0] });
  } catch (error) {
    console.error('Fehler beim Aktualisieren der Charge:', error);
    if (error.code === '23505') {
      return res.status(409).json({ message: 'Diese Chargennummer existiert bereits.' });
    }
    return res.status(500).json({ message: 'Interner Serverfehler' });
  }
});

// DELETE /api/batches/:id – nur wenn keine Orders existieren
apiRouter.delete('/batches/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const check = await pool.query('SELECT 1 FROM order_line_items WHERE batch_id = $1 LIMIT 1;', [id]);
    if (check.rows.length > 0) {
      return res.status(409).json({ message: 'Löschen nicht möglich: Für diese Charge existieren bereits Bestellungen.' });
    }
    const del = await pool.query('DELETE FROM batches WHERE id = $1 RETURNING *;', [id]);
    if (!del.rows.length) return res.status(404).json({ message: 'Charge nicht gefunden.' });
    return res.json({ message: 'Charge gelöscht.' });
  } catch (error) {
    console.error('Fehler beim Löschen der Charge:', error);
    return res.status(500).json({ message: 'Interner Serverfehler' });
  }
});

// GET /api/orders/batch/:batchNumber – Rückverfolgung
apiRouter.get('/orders/batch/:batchNumber', async (req, res) => {
  const { batchNumber } = req.params;
  try {
    const q = `
      SELECT o.shopify_order_id AS "orderId",
             o.customer_name     AS "customer",
             o.order_date        AS "date",
             p.name              AS "productName",
             li.quantity         AS "quantity"
        FROM orders o
        JOIN order_line_items li ON o.id = li.order_id
        JOIN batches b           ON li.batch_id = b.id
        JOIN products p          ON li.product_id = p.id
       WHERE b.batch_number = $1
       ORDER BY o.order_date DESC, o.id DESC;
    `;
    const { rows } = await pool.query(q, [batchNumber]);
    if (!rows.length) return res.status(404).json({ message: `Keine Bestellungen für Charge ${batchNumber} gefunden.` });
    return res.json({ batchNumber, orders: rows });
  } catch (error) {
    console.error('Fehler bei /orders/batch/:batchNumber', error);
    return res.status(500).json({ message: 'Interner Serverfehler' });
  }
});

// POST /api/orders – geschützt; nutzt dieselbe Logik wie Webhook
apiRouter.post('/orders', async (req, res) => {
  const { shop } = req;
  try {
    await processOrder(shop, req.body);
    return res.status(201).json({ message: 'Bestellung verarbeitet.' });
  } catch (error) {
    console.error('Fehler bei /api/orders:', error?.response?.data || error.message);
    return res.status(500).json({ message: 'Interner Serverfehler' });
  }
});

// Mount der API
app.use('/api', apiRouter);

// Healthcheck
app.get('/', (req, res) => res.status(200).send('Backend mit Webhook orders/create ist aktiv.'));
app.listen(port, () => console.log(`Server läuft auf Port ${port}`));
