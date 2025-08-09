// --- Import der notwendigen Bibliotheken ---
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const crypto = require('crypto'); // Für HMAC-Verifizierung
const axios = require('axios'); // Für Server-zu-Server Anfragen

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
-- Führen Sie diesen Befehl im SQL-Editor Ihrer Datenbank aus, um die neue Tabelle zu erstellen.
CREATE TABLE IF NOT EXISTS installations (
    shop VARCHAR(255) PRIMARY KEY,
    access_token VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
-- Stellen Sie sicher, dass auch die anderen Tabellen (products, batches, etc.) existieren.
*/

// --- Authentifizierungs-Logik ---

// Schritt 1: Start der Installation. Leitet den Nutzer zu Shopify.
app.get('/api/auth', (req, res) => {
    const shop = req.query.shop;
    if (!shop) {
        return res.status(400).send('Missing shop parameter.');
    }
    const scopes = 'read_products,read_orders,write_products';
    const redirectUri = `https://shopify-lottracker-backend.onrender.com/api/auth/callback`;
    const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${scopes}&redirect_uri=${redirectUri}`;
    res.redirect(installUrl);
});

// Schritt 2: Shopify leitet nach der Zustimmung hierher zurück.
app.get('/api/auth/callback', async (req, res) => {
    const { shop, hmac, code } = req.query;
    if (!shop || !hmac || !code) {
        return res.status(400).send('Required parameters missing.');
    }

    // HMAC-Verifizierung
    const map = { ...req.query };
    delete map['hmac'];
    const message = new URLSearchParams(map).toString();
    const providedHmac = Buffer.from(hmac, 'hex');
    const generatedHmac = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(message).digest();

    if (!crypto.timingSafeEqual(providedHmac, generatedHmac)) {
        return res.status(400).send('HMAC validation failed');
    }

    // Schritt 3: Code gegen Access Token tauschen
    try {
        const accessTokenResponse = await axios.post(`https://${shop}/admin/oauth/access_token`, {
            client_id: SHOPIFY_API_KEY,
            client_secret: SHOPIFY_API_SECRET,
            code,
        });
        const accessToken = accessTokenResponse.data.access_token;

        // Schritt 4: Access Token in DB speichern
        const storeQuery = `
            INSERT INTO installations (shop, access_token) VALUES ($1, $2)
            ON CONFLICT (shop) DO UPDATE SET access_token = $2;
        `;
        await pool.query(storeQuery, [shop, accessToken]);

        // Schritt 5: Nutzer zur App im Shopify Admin weiterleiten
        res.redirect(`https://${shop}/admin/apps/zurifoods-lottracker`);

    } catch (error) {
        console.error('Error getting access token:', error.response ? error.response.data : error.message);
        res.status(500).send('Error getting access token.');
    }
});

// --- Geschützte API-Endpunkte ---

const apiRouter = express.Router();

// Middleware zur Verifizierung des JWT-Tokens aus dem Frontend
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
apiRouter.use(verifyShopifySession);

// POST /api/batches
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
            return res.status(409).json({ message: `Diese Chargennummer existiert bereits.` });
        }
        res.status(500).json({ message: 'Interner Serverfehler' });
    } finally {
        client.release();
    }
});

// GET /api/orders/batch/:batchNumber
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


app.use('/api', apiRouter);


// --- Server starten ---
app.listen(port, () => console.log(`Backend (v5 mit OAuth) läuft auf Port ${port}.`));
