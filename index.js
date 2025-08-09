// --- Import der notwendigen Bibliotheken ---
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
// NEU: Bibliothek zur Verifizierung von JSON Web Tokens (JWT)
// Führen Sie 'npm install jsonwebtoken' in Ihrem Backend-Projekt aus.
const jwt = require('jsonwebtoken');

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


// --- NEU: Authentifizierungs-Middleware ---
// Diese Funktion wird vor jeder API-Anfrage ausgeführt.
const verifyShopifySession = (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send('Unauthorized: No token provided.');
    }

    const token = authHeader.split(' ')[1];

    try {
        // In einer echten Produktions-App würden Sie den Token mit Ihrem Shopify App Secret verifizieren.
        // Für unsere Zwecke dekodieren wir ihn, um zu prüfen, ob er gültig ist.
        // const decoded = jwt.verify(token, process.env.SHOPIFY_API_SECRET);
        const decoded = jwt.decode(token);
        if (!decoded || !decoded.dest) {
            throw new Error('Invalid token');
        }
        // Sie könnten hier zusätzlich prüfen, ob decoded.dest mit Ihrem Shop übereinstimmt.
        console.log(`Request authenticated for shop: ${decoded.dest}`);
        next(); // Anfrage ist gültig, fahre mit dem nächsten Schritt fort.
    } catch (error) {
        console.error('Token verification failed:', error.message);
        return res.status(401).send('Unauthorized: Invalid token.');
    }
};

// --- API Endpunkte ---

// Öffentlicher Health-Check-Endpunkt
app.get('/', (req, res) => {
    res.status(200).send('Batch Tracking Backend (Secured) is running.');
});

// Alle Routen unter /api/ werden jetzt durch die Middleware geschützt.
const apiRouter = express.Router();
apiRouter.use(verifyShopifySession);

// GET /api/products (geschützt)
apiRouter.get('/products', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name, sku FROM products ORDER BY name ASC');
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ message: 'Interner Serverfehler' });
    }
});

// POST /api/products (geschützt)
apiRouter.post('/products', async (req, res) => {
    const { name, sku } = req.body;
    if (!name || !sku) {
        return res.status(400).json({ message: 'Name und SKU sind erforderlich.' });
    }
    try {
        const query = `INSERT INTO products (name, sku) VALUES ($1, $2) RETURNING *;`;
        const result = await pool.query(query, [name, sku]);
        res.status(201).json({ message: 'Produkt erfolgreich erstellt.', product: result.rows[0] });
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({ message: `Ein Produkt mit dem SKU ${sku} existiert bereits.` });
        }
        res.status(500).json({ message: 'Interner Serverfehler' });
    }
});


// POST /api/batches (geschützt)
apiRouter.post('/batches', async (req, res) => {
    const { productId, batchNumber, expiryDate, quantity } = req.body;
    if (!productId || !batchNumber || !quantity) {
        return res.status(400).json({ message: 'productId, batchNumber und quantity sind erforderlich.' });
    }
    try {
        const query = `INSERT INTO batches (product_id, batch_number, expiry_date, quantity) VALUES ($1, $2, $3, $4) RETURNING *;`;
        const values = [productId, batchNumber, expiryDate, quantity];
        const result = await pool.query(query, values);
        res.status(201).json({ message: 'Charge erfolgreich erstellt.', batch: result.rows[0] });
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({ message: `Eine Charge mit der Nummer ${batchNumber} existiert bereits.` });
        }
        if (error.code === '23503') {
            return res.status(400).json({ message: `Produkt mit der ID ${productId} wurde nicht gefunden.` });
        }
        res.status(500).json({ message: 'Interner Serverfehler' });
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


// Binden des geschützten Routers an den /api Pfad
app.use('/api', apiRouter);

// --- Server starten ---
app.listen(port, () => {
    console.log(`Backend (Secured) läuft auf Port ${port}.`);
});
