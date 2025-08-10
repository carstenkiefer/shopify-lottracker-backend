// --- Import der notwendigen Bibliotheken ---
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;
const { SHOPIFY_API_KEY, SHOPIFY_API_SECRET, DATABASE_URL } = process.env;

app.use(cors());
app.use(express.json());

// --- DB-Verbindung ---
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// --- Shopify API Helper ---
const makeShopifyApiCall = async (shop, query) => {
    const dbResult = await pool.query('SELECT access_token FROM installations WHERE shop = $1', [shop]);
    if (dbResult.rows.length === 0) {
        throw new Error(`Keine Installation für den Shop ${shop} gefunden.`);
    }
    const accessToken = dbResult.rows[0].access_token;
    const apiUrl = `https://${shop}/admin/api/2023-10/graphql.json`;

    const response = await axios.post(apiUrl, { query }, {
        headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': accessToken,
        },
    });
    return response.data;
};

// --- Middleware ---
const apiRouter = express.Router();
const verifyShopifySession = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ message: 'Unauthorized: No token provided.' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.decode(token);
        if (!decoded || !decoded.dest) throw new Error('Invalid token');
        req.shop = decoded.dest.replace('https://', '');
        next();
    } catch (error) {
        return res.status(401).send({ message: 'Unauthorized: Invalid token.' });
    }
};
apiRouter.use(verifyShopifySession);

/**
 * POST /api/batches
 * Erstellt eine neue Charge. Holt sich das Standard-MHD aus den Shopify-Metafeldern, wenn keines angegeben ist.
 */
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
            const newProductResult = await client.query(
                `INSERT INTO products (shopify_product_id, name, sku) VALUES ($1, $2, $3) RETURNING id;`,
                [shopifyProductId, productName, productSku]
            );
            internalProductId = newProductResult.rows[0].id;
        }

        let finalExpiryDate = expiryDate;

        if (!finalExpiryDate) {
            // GraphQL-Query, um das Metafeld für die Haltbarkeit abzurufen
            const query = `
                query {
                    product(id: "${shopifyProductId}") {
                        shelfLife: metafield(namespace: "custom", key: "default_shelf_life_days") {
                            value
                        }
                    }
                }
            `;
            const apiResponse = await makeShopifyApiCall(shop, query);
            const shelfLifeDays = apiResponse.data.product?.shelfLife?.value;

            if (shelfLifeDays) {
                const today = new Date();
                today.setDate(today.getDate() + parseInt(shelfLifeDays, 10));
                finalExpiryDate = today.toISOString().split('T')[0];
            }
        }

        const batchQuery = `INSERT INTO batches (product_id, batch_number, expiry_date, quantity) VALUES ($1, $2, $3, $4) RETURNING *;`;
        const newBatchResult = await client.query(batchQuery, [internalProductId, batchNumber, finalExpiryDate, quantity]);

        await client.query('COMMIT');
        res.status(201).json({ message: 'Charge erfolgreich erstellt.', batch: newBatchResult.rows[0] });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Fehler beim Erstellen der Charge:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: 'Interner Serverfehler' });
    } finally {
        client.release();
    }
});

/**
 * 📌 NEU: Alle Chargen abrufen
 */
apiRouter.get('/batches', async (req, res) => {
    try {
        const query = `
            SELECT b.id, b.batch_number, b.expiry_date, b.quantity,
                   p.name AS product_name, p.sku
            FROM batches b
            JOIN products p ON b.product_id = p.id
            ORDER BY b.created_at DESC;
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (error) {
        console.error('Fehler beim Abrufen der Chargen:', error.message);
        res.status(500).json({ message: 'Interner Serverfehler' });
    }
});

/**
 * 📌 NEU: Charge bearbeiten
 */
apiRouter.put('/batches/:id', async (req, res) => {
    const { id } = req.params;
    const { expiryDate, quantity } = req.body;
    try {
        const updateQuery = `
            UPDATE batches
            SET expiry_date = $1, quantity = $2
            WHERE id = $3
            RETURNING *;
        `;
        const result = await pool.query(updateQuery, [expiryDate, quantity, id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Charge nicht gefunden.' });
        }
        res.json({ message: 'Charge aktualisiert.', batch: result.rows[0] });
    } catch (error) {
        console.error('Fehler beim Bearbeiten der Charge:', error.message);
        res.status(500).json({ message: 'Interner Serverfehler' });
    }
});

/**
 * 📌 NEU: Charge löschen (nur wenn keine Bestellungen vorhanden)
 */
apiRouter.delete('/batches/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const checkOrders = await pool.query(
            'SELECT COUNT(*) FROM order_line_items WHERE batch_id = $1',
            [id]
        );
        if (parseInt(checkOrders.rows[0].count, 10) > 0) {
            return res.status(400).json({ message: 'Charge kann nicht gelöscht werden, da Bestellungen vorhanden sind.' });
        }
        const delResult = await pool.query('DELETE FROM batches WHERE id = $1 RETURNING *', [id]);
        if (delResult.rows.length === 0) {
            return res.status(404).json({ message: 'Charge nicht gefunden.' });
        }
        res.json({ message: 'Charge erfolgreich gelöscht.' });
    } catch (error) {
        console.error('Fehler beim Löschen der Charge:', error.message);
        res.status(500).json({ message: 'Interner Serverfehler' });
    }
});

/**
 * 📌 NEU: Bestellungen zu einer Charge abrufen
 */
apiRouter.get('/orders/batch/:batchNumber', async (req, res) => {
    const { batchNumber } = req.params;
    try {
        const query = `
            SELECT o.shopify_order_id AS "orderId",
                   o.customer_name AS "customer",
                   o.order_date AS "date",
                   p.name AS "productName",
                   li.quantity
            FROM orders o
            JOIN order_line_items li ON o.id = li.order_id
            JOIN batches b ON li.batch_id = b.id
            JOIN products p ON li.product_id = p.id
            WHERE b.batch_number = $1;
        `;
        const result = await pool.query(query, [batchNumber]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: `Keine Bestellungen für Charge ${batchNumber} gefunden.` });
        }
        res.json({ batchNumber, orders: result.rows });
    } catch (error) {
        console.error('Fehler bei /orders/batch/:batchNumber', error);
        res.status(500).json({ message: 'Interner Serverfehler' });
    }
});

/**
 * POST /api/orders
 * Ordnet Chargen automatisch zu und legt bei Bedarf neue an (bestehende Funktion).
 */
apiRouter.post('/orders', async (req, res) => {
    const { shopifyOrderId, customerName, orderDate, lineItems } = req.body;
    const { shop } = req;

    if (!shopifyOrderId || !lineItems || !lineItems.length) {
        return res.status(400).json({ message: 'Bestell-ID und Artikel sind erforderlich.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const orderResult = await client.query(
            `INSERT INTO orders (shopify_order_id, customer_name, order_date) VALUES ($1, $2, $3) RETURNING id;`,
            [shopifyOrderId, customerName, orderDate]
        );
        const newOrderId = orderResult.rows[0].id;

        for (const item of lineItems) {
            let quantityToFulfill = item.quantity;
            let productInfo = await client.query(
                'SELECT id, sku FROM products WHERE shopify_product_id = $1',
                [item.shopifyProductId]
            );

            if (productInfo.rows.length === 0) {
                const newProductResult = await client.query(
                    `INSERT INTO products (shopify_product_id, name, sku) VALUES ($1, $2, $3) RETURNING id, sku;`,
                    [item.shopifyProductId, item.productName, item.productSku]
                );
                productInfo = newProductResult;
            }
            const internalProductId = productInfo.rows[0].id;
            const productSku = productInfo.rows[0].sku;

            const batchesResult = await client.query(
                'SELECT id, quantity FROM batches WHERE product_id = $1 AND quantity > 0 ORDER BY expiry_date ASC, created_at ASC',
                [internalProductId]
            );

            for (const batch of batchesResult.rows) {
                if (quantityToFulfill <= 0) break;
                const quantityFromThisBatch = Math.min(quantityToFulfill, batch.quantity);
                await client.query('UPDATE batches SET quantity = quantity - $1 WHERE id = $2', [quantityFromThisBatch, batch.id]);
                await client.query('INSERT INTO order_line_items (order_id, product_id, batch_id, quantity) VALUES ($1, $2, $3, $4)', [newOrderId, internalProductId, batch.id, quantityFromThisBatch]);
                quantityToFulfill -= quantityFromThisBatch;
            }

            if (quantityToFulfill > 0) {
                const query = `
                    query {
                        product(id: "${item.shopifyProductId}") {
                            shelfLife: metafield(namespace: "custom", key: "default_shelf_life_days") { value }
                            batchQuantity: metafield(namespace: "custom", key: "default_batch_quantity") { value }
                        }
                    }
                `;
                const apiResponse = await makeShopifyApiCall(shop, query);
                const shelfLifeDays = apiResponse.data.product?.shelfLife?.value;
                const defaultBatchQuantity = apiResponse.data.product?.batchQuantity?.value;

                const now = new Date();
                const newBatchNumber = `${productSku || 'PROD'}-${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}-${now.getTime()}`;

                let newExpiryDate = null;
                if (shelfLifeDays) {
                    now.setDate(now.getDate() + parseInt(shelfLifeDays, 10));
                    newExpiryDate = now.toISOString().split('T')[0];
                }

                const newBatchQuantity = defaultBatchQuantity ? parseInt(defaultBatchQuantity, 10) : 100;
                const newBatchResult = await client.query(
                    'INSERT INTO batches (product_id, batch_number, expiry_date, quantity) VALUES ($1, $2, $3, $4) RETURNING id',
                    [internalProductId, newBatchNumber, newExpiryDate, newBatchQuantity]
                );
                const newBatchId = newBatchResult.rows[0].id;

                await client.query('UPDATE batches SET quantity = quantity - $1 WHERE id = $2', [quantityToFulfill, newBatchId]);
                await client.query('INSERT INTO order_line_items (order_id, product_id, batch_id, quantity) VALUES ($1, $2, $3, $4)', [newOrderId, internalProductId, newBatchId, quantityToFulfill]);
            }
        }

        await client.query('COMMIT');
        res.status(201).json({ message: 'Bestellung erfolgreich erstellt und Chargen automatisch zugewiesen.' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Fehler bei der automatischen Chargenzuweisung:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: 'Interner Serverfehler' });
    } finally {
        client.release();
    }
});

app.use('/api', apiRouter);

// --- Health Check ---
app.get('/', (req, res) => res.status(200).send('Batch Tracking Backend mit Chargenverwaltung läuft.'));
app.listen(port, () => console.log(`Backend läuft auf Port ${port}`));
