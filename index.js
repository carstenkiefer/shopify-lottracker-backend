// --- Import der notwendigen Bibliotheken ---
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const axios = require('axios');

// --- Konfiguration ---
const app = express();
const port = process.env.PORT || 3000;
const { SHOPIFY_API_KEY, SHOPIFY_API_SECRET, DATABASE_URL } = process.env;

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- Datenbank-Verbindung ---
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// --- SQL-Struktur ---
/*
-- WICHTIGE ÄNDERUNG: Die Spalten für Haltbarkeit und Menge werden aus unserer DB entfernt.
-- Diese Daten leben jetzt als Metafelder direkt in Shopify.
-- Stellen Sie sicher, dass Ihre `products`-Tabelle diese einfache Struktur hat.

CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    shopify_product_id VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    sku VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Stellen Sie sicher, dass auch die anderen Tabellen existieren:
CREATE TABLE IF NOT EXISTS installations ( ... );
CREATE TABLE IF NOT EXISTS batches ( ... );
CREATE TABLE IF NOT EXISTS orders ( ... );
CREATE TABLE IF NOT EXISTS order_line_items ( ... );
*/

// --- Authentifizierungs-Logik (Öffentliche Routen) ---
// ... (Der Code für /api/auth und /api/auth/callback bleibt unverändert) ...


// --- Hilfsfunktion für Shopify API-Aufrufe ---
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


// --- Geschützte API-Endpunkte ---

const apiRouter = express.Router();
const verifyShopifySession = (req, res, next) => {DROP Table products;
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ message: 'Unauthorized: No token provided.' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.decode(token);
        if (!decoded || !decoded.dest) throw new Error('Invalid token');
        req.shop = decoded.dest.replace('https://', ''); // Shop-Domain für API-Aufrufe verfügbar machen
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
    const { shop } = req; // Shop-Domain aus der Middleware

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
            const newProductResult = await client.query(`INSERT INTO products (shopify_product_id, name, sku) VALUES ($1, $2, $3) RETURNING id;`, [shopifyProductId, productName, productSku]);
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
 * POST /api/orders
 * Ordnet Chargen automatisch zu und legt bei Bedarf neue an, basierend auf Shopify-Metafeldern.
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

        const orderResult = await client.query(`INSERT INTO orders (shopify_order_id, customer_name, order_date) VALUES ($1, $2, $3) RETURNING id;`, [shopifyOrderId, customerName, orderDate]);
        const newOrderId = orderResult.rows[0].id;

        for (const item of lineItems) {
            let quantityToFulfill = item.quantity;
            let productInfo = await client.query('SELECT id, sku FROM products WHERE shopify_product_id = $1', [item.shopifyProductId]);
            
            if (productInfo.rows.length === 0) {
                 // Produkt in unserer DB anlegen, falls es durch einen anderen Prozess noch nicht existiert
                const newProductResult = await client.query(`INSERT INTO products (shopify_product_id, name, sku) VALUES ($1, $2, $3) RETURNING id, sku;`, [item.shopifyProductId, item.productName, item.productSku]);
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
                // Wenn Ware fehlt, Metafelder von Shopify abrufen
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
                const newBatchResult = await client.query('INSERT INTO batches (product_id, batch_number, expiry_date, quantity) VALUES ($1, $2, $3, $4) RETURNING id', [internalProductId, newBatchNumber, newExpiryDate, newBatchQuantity]);
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
app.get('/', (req, res) => res.status(200).send('Batch Tracking Backend (v7 - Metafields) is running.'));
app.listen(port, () => console.log(`Backend (v7) läuft auf Port ${port}.`));
