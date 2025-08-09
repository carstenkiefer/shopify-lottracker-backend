// --- Import der notwendigen Bibliotheken ---
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken'); // Für die Token-Verifizierung

// --- Konfiguration ---
const app = express();
const port = process.env.PORT || 3000;

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- Datenbank-Verbindung (PostgreSQL) ---
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
    console.error('FATAL ERROR: DATABASE_URL is not set.');
    process.exit(1);
}
const pool = new Pool({
    connectionString: connectionString,
    ssl: { rejectUnauthorized: false }
});

// --- SQL-Struktur ---
/*
-- Stellen Sie sicher, dass Ihre `products`-Tabelle diese Struktur hat.
-- LÖSCHEN SIE ZUERST DIE ALTE "products"-TABELLE, falls vorhanden.
-- DROP TABLE products;

CREATE TABLE products (
    id SERIAL PRIMARY KEY,
    shopify_product_id VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    sku VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
*/

// --- Authentifizierungs-Middleware ---
const verifyShopifySession = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ message: 'Unauthorized: No token provided.' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.decode(token);
        if (!decoded || !decoded.dest) throw new Error('Invalid token');
        console.log(`Request authenticated for shop: ${decoded.dest}`);
        next();
    } catch (error) {
        return res.status(401).send({ message: 'Unauthorized: Invalid token.' });
    }
};

// --- API Router ---
const apiRouter = express.Router();
apiRouter.use(verifyShopifySession); // Alle /api Routen sind jetzt geschützt

// GET /api/products (geschützt)
// Ruft alle Produkte ab, für die bereits Chargen existieren.
apiRouter.get('/products', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, shopify_product_id, name, sku FROM products ORDER BY name ASC');
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ message: 'Interner Serverfehler' });
    }
});

// POST /api/batches (geschützt)
// Erstellt eine neue Charge und legt bei Bedarf das zugehörige Produkt an.
apiRouter.post('/batches', async (req, res) => {
    const { shopifyProductId, productName, productSku, batchNumber, expiryDate, quantity } = req.body;
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
            const newProductQuery = `INSERT INTO products (shopify_product_id, name, sku) VALUES ($1, $2, $3) RETURNING id;`;
            const newProductResult = await client.query(newProductQuery, [shopifyProductId, productName, productSku]);
            internalProductId = newProductResult.rows[0].id;
        }

        const batchQuery = `INSERT INTO batches (product_id, batch_number, expiry_date, quantity) VALUES ($1, $2, $3, $4) RETURNING *;`;
        const newBatchResult = await client.query(batchQuery, [internalProductId, batchNumber, expiryDate, quantity]);

        await client.query('COMMIT');
        res.status(201).json({ message: 'Charge erfolgreich erstellt.', batch: newBatchResult.rows[0] });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Fehler beim Erstellen der Charge:', error);
        if (error.code === '23505') {
            return res.status(409).json({ message: `Diese Chargennummer oder dieses Produkt (SKU) existiert bereits.` });
        }
        res.status(500).json({ message: 'Interner Serverfehler' });
    } finally {
        client.release();
    }
});

// GET /api/orders/batch/:batchNumber (geschützt)
apiRouter.get('/orders/batch/:batchNumber', async (req, res) => {
    const { batchNumber } = req.params;
    try {
        const query = `
            SELECT o.shopify_order_id AS "orderId", o.customer_name AS "customer", o.order_date AS "date", p.name AS "productName", li.quantity
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
        res.json({ batchNumber: batchNumber, orders: result.rows });
    } catch (error) {
        res.status(500).json({ message: 'Interner Serverfehler' });
    }
});

// Binden des Routers
app.use('/api', apiRouter);

// Öffentlicher Health-Check
app.get('/', (req, res) => res.status(200).send('Batch Tracking Backend (v4) is running.'));

// Server starten
app.listen(port, () => console.log(`Backend (v4) läuft auf Port ${port}.`));
