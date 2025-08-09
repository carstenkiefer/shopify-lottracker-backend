// --- Import der notwendigen Bibliotheken ---
const express = require('express');
const cors = require('cors');
// Wir verwenden wieder den 'pg' Treiber für PostgreSQL.
// Führen Sie 'npm install pg' aus.
const { Pool } = require('pg');

// --- Konfiguration ---
const app = express();
// Render.com stellt den Port über eine Umgebungsvariable bereit.
const port = process.env.PORT || 3000;

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- Datenbank-Verbindung (PostgreSQL) ---
// Die Verbindung wird über eine einzige URL hergestellt, die in den Umgebungsvariablen
// auf Render.com gespeichert wird. Dies ist sicher und flexibel.
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    console.error('FATAL ERROR: DATABASE_URL is not set.');
    process.exit(1); // Beendet die Anwendung, wenn keine DB-Verbindung möglich ist.
}

const pool = new Pool({
    connectionString: connectionString,
    // Wenn Sie sich mit einer DB verbinden, die SSL erfordert (fast alle Cloud-Anbieter)
    ssl: {
        rejectUnauthorized: false
    }
});

// Testen der Datenbankverbindung
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('Fehler bei der Verbindung zur Datenbank', err.stack);
    } else {
        console.log('Erfolgreich mit der Cloud-Datenbank verbunden.');
    }
});


/*
--- SQL-Struktur für die PostgreSQL-Datenbank ---
-- Führen Sie diese Befehle im SQL-Editor Ihres Datenbank-Anbieters (z.B. Supabase) aus.

CREATE TABLE products (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    sku VARCHAR(100) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE batches (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    batch_number VARCHAR(100) UNIQUE NOT NULL,
    expiry_date DATE,
    quantity INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    shopify_order_id VARCHAR(255) UNIQUE NOT NULL,
    customer_name VARCHAR(255),
    order_date DATE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE order_line_items (
    id SERIAL PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    batch_id INTEGER NOT NULL REFERENCES batches(id),
    quantity INTEGER NOT NULL
);

*/


// --- API Endpunkte ---

/**
 * GET /
 * Health-Check-Endpunkt, damit Render den Status des Dienstes überprüfen kann.
 */
app.get('/', (req, res) => {
    res.status(200).send('Batch Tracking Backend is running and connected to cloud database.');
});

/**
 * NEU: GET /api/products
 * Ruft eine Liste aller Produkte aus der Datenbank ab.
 */
app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name, sku FROM products ORDER BY name ASC');
        res.json(result.rows);
    } catch (error) {
        console.error('Fehler beim Abrufen der Produkte:', error);
        res.status(500).json({ message: 'Interner Serverfehler' });
    }
});


/**
 * POST /api/batches
 * Erstellt eine neue Charge für ein Produkt in der Datenbank.
 */
app.post('/api/batches', async (req, res) => {
    const { productId, batchNumber, expiryDate, quantity } = req.body;

    if (!productId || !batchNumber || !quantity) {
        return res.status(400).json({ message: 'productId, batchNumber und quantity sind erforderlich.' });
    }

    try {
        const query = `
            INSERT INTO batches (product_id, batch_number, expiry_date, quantity)
            VALUES ($1, $2, $3, $4)
            RETURNING *;
        `;
        const values = [productId, batchNumber, expiryDate, quantity];
        const result = await pool.query(query, values);

        res.status(201).json({ message: 'Charge erfolgreich erstellt.', batch: result.rows[0] });
    } catch (error) {
        console.error('Fehler beim Erstellen der Charge:', error);
        // VERBESSERTE FEHLERBEHANDLUNG
        if (error.code === '23505') { // unique_violation for batch_number
            return res.status(409).json({ message: `Eine Charge mit der Nummer ${batchNumber} existiert bereits.` });
        }
        if (error.code === '23503') { // foreign_key_violation for product_id
            return res.status(400).json({ message: `Produkt mit der ID ${productId} wurde nicht gefunden.` });
        }
        res.status(500).json({ message: 'Interner Serverfehler' });
    }
});


/**
 * POST /api/orders
 * Erstellt eine neue Bestellung und verknüpft die Artikel mit spezifischen Chargen.
 */
app.post('/api/orders', async (req, res) => {
    const { shopifyOrderId, customerName, orderDate, lineItems } = req.body;

    if (!shopifyOrderId || !lineItems || lineItems.length === 0) {
        return res.status(400).json({ message: 'shopifyOrderId und mindestens ein lineItem sind erforderlich.' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const orderQuery = `
            INSERT INTO orders (shopify_order_id, customer_name, order_date)
            VALUES ($1, $2, $3)
            RETURNING id;
        `;
        const orderResult = await client.query(orderQuery, [shopifyOrderId, customerName, orderDate]);
        const newOrderId = orderResult.rows[0].id;

        for (const item of lineItems) {
            const lineItemQuery = `
                INSERT INTO order_line_items (order_id, product_id, batch_id, quantity)
                VALUES ($1, $2, $3, $4);
            `;
            await client.query(lineItemQuery, [newOrderId, item.productId, item.batchId, item.quantity]);
            
            const updateBatchQuery = `
                UPDATE batches SET quantity = quantity - $1 WHERE id = $2;
            `;
            await client.query(updateBatchQuery, [item.quantity, item.batchId]);
        }

        await client.query('COMMIT');
        res.status(201).json({ message: 'Bestellung erfolgreich erstellt.', orderId: newOrderId });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Fehler beim Erstellen der Bestellung:', error);
        res.status(500).json({ message: 'Interner Serverfehler' });
    } finally {
        client.release();
    }
});


/**
 * GET /api/orders/batch/:batchNumber
 * Findet alle Bestellungen, die eine bestimmte Charge enthalten, durch eine DB-Abfrage.
 */
app.get('/api/orders/batch/:batchNumber', async (req, res) => {
    const { batchNumber } = req.params;

    try {
        const query = `
            SELECT
                o.shopify_order_id AS "orderId",
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
        
        res.json({
            batchNumber: batchNumber,
            orders: result.rows
        });

    } catch (error) {
        console.error('Fehler bei der Suche nach Bestellungen:', error);
        res.status(500).json({ message: 'Interner Serverfehler' });
    }
});


// --- Server starten ---
app.listen(port, () => {
    console.log(`Backend läuft auf Port ${port} und ist bereit für die Cloud-DB-Verbindung.`);
});
