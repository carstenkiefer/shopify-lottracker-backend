// --- Import der notwendigen Bibliotheken ---
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

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

// --- WICHTIG: Aktualisierte SQL-Struktur ---
/*
-- Führen Sie diesen Befehl im SQL-Editor Ihrer Datenbank aus.
-- LÖSCHEN SIE ZUERST DIE ALTE "products"-TABELLE, falls vorhanden.
-- DROP TABLE products;

CREATE TABLE products (
    id SERIAL PRIMARY KEY,
    shopify_product_id VARCHAR(255) UNIQUE NOT NULL, -- Eindeutige ID von Shopify
    name VARCHAR(255) NOT NULL,
    sku VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Die anderen Tabellen (batches, orders, order_line_items) bleiben unverändert.
*/

// --- API Endpunkte ---

/**
 * GET /
 * Health-Check-Endpunkt
 */
app.get('/', (req, res) => {
    res.status(200).send('Batch Tracking Backend (v3) is running.');
});

/**
 * POST /api/batches
 * Erstellt eine neue Charge. Legt das Produkt in unserer DB an, falls es noch nicht existiert.
 */
app.post('/api/batches', async (req, res) => {
    // Erwartet jetzt die Shopify-Produkt-ID und weitere Details
    const { shopifyProductId, productName, productSku, batchNumber, expiryDate, quantity } = req.body;

    if (!shopifyProductId || !batchNumber || !quantity) {
        return res.status(400).json({ message: 'Shopify Produkt-ID, Chargennummer und Menge sind erforderlich.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Schritt 1: Prüfen, ob das Produkt bereits in unserer DB existiert (Upsert-Logik)
        let productResult = await client.query('SELECT id FROM products WHERE shopify_product_id = $1', [shopifyProductId]);
        let internalProductId;

        if (productResult.rows.length > 0) {
            // Produkt existiert bereits, wir verwenden die interne ID
            internalProductId = productResult.rows[0].id;
        } else {
            // Produkt existiert nicht, wir legen es an
            const newProductQuery = `
                INSERT INTO products (shopify_product_id, name, sku)
                VALUES ($1, $2, $3)
                RETURNING id;
            `;
            const newProductResult = await client.query(newProductQuery, [shopifyProductId, productName, productSku]);
            internalProductId = newProductResult.rows[0].id;
        }

        // Schritt 2: Die neue Charge mit der internen Produkt-ID erstellen
        const batchQuery = `
            INSERT INTO batches (product_id, batch_number, expiry_date, quantity)
            VALUES ($1, $2, $3, $4)
            RETURNING *;
        `;
        const batchValues = [internalProductId, batchNumber, expiryDate, quantity];
        const newBatchResult = await client.query(batchQuery, batchValues);

        await client.query('COMMIT');
        res.status(201).json({ message: 'Charge erfolgreich erstellt.', batch: newBatchResult.rows[0] });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Fehler beim Erstellen der Charge:', error);
        if (error.code === '23505') {
            return res.status(409).json({ message: `Eine Charge oder ein Produkt mit diesen Daten existiert bereits.` });
        }
        res.status(500).json({ message: 'Interner Serverfehler' });
    } finally {
        client.release();
    }
});


// Die Endpunkte für Bestellungen und Rückverfolgung bleiben größtenteils gleich,
// da sie auf den internen IDs basieren.
/**
 * POST /api/orders
 * Erstellt eine neue Bestellung.
 */
app.post('/api/orders', async (req, res) => {
    const { shopifyOrderId, customerName, orderDate, lineItems } = req.body;
    if (!shopifyOrderId || !lineItems || lineItems.length === 0) {
        return res.status(400).json({ message: 'Shopify-Bestell-ID und Artikel sind erforderlich.' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const orderQuery = `INSERT INTO orders (shopify_order_id, customer_name, order_date) VALUES ($1, $2, $3) RETURNING id;`;
        const orderResult = await client.query(orderQuery, [shopifyOrderId, customerName, orderDate]);
        const newOrderId = orderResult.rows[0].id;

        for (const item of lineItems) {
            const lineItemQuery = `INSERT INTO order_line_items (order_id, product_id, batch_id, quantity) VALUES ($1, $2, $3, $4);`;
            await client.query(lineItemQuery, [newOrderId, item.productId, item.batchId, item.quantity]);
            const updateBatchQuery = `UPDATE batches SET quantity = quantity - $1 WHERE id = $2;`;
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
 * Findet alle Bestellungen, die eine bestimmte Charge enthalten.
 */
app.get('/api/orders/batch/:batchNumber', async (req, res) => {
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
        console.error('Fehler bei der Suche nach Bestellungen:', error);
        res.status(500).json({ message: 'Interner Serverfehler' });
    }
});


// --- Server starten ---
app.listen(port, () => {
    console.log(`Backend (v3) läuft auf Port ${port} und ist bereit für die Cloud-DB-Verbindung.`);
});
