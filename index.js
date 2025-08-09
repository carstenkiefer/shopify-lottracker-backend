// --- Import der notwendigen Bibliotheken ---
const express = require('express');
const cors = require('cors');
const path = require('path'); // Hinzugefügt, um Pfade korrekt zu verwalten
// Importieren des SQLite3-Treibers.
// Führen Sie 'npm install sqlite3' aus, um ihn zu installieren.
const sqlite3 = require('sqlite3').verbose();

// --- Konfiguration ---
const app = express();
// Render.com stellt den Port über eine Umgebungsvariable bereit.
// Lokal verwenden wir weiterhin Port 3000.
const port = process.env.PORT || 3000;

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- Datenbank-Verbindung (SQLite) ---
// Auf Render verwenden wir einen persistenten Speicher, der unter /var/data gemountet wird.
// Lokal bleibt die Datenbank im Projektverzeichnis.
const dataDir = process.env.RENDER_DATA_DIR || '.';
const dbPath = path.join(dataDir, 'batches.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Fehler beim Öffnen der SQLite-Datenbank', err.message);
    } else {
        console.log(`Erfolgreich mit der SQLite-Datenbank verbunden: ${dbPath}`);
        // Erstellt die Tabellen, falls sie noch nicht existieren.
        db.exec(SQL_TABLE_CREATION_COMMANDS, (err) => {
            if (err) {
                console.error("Fehler beim Erstellen der Tabellen:", err);
            } else {
                console.log("Tabellen erfolgreich erstellt oder bereits vorhanden.");
            }
        });
    }
});


/*
--- SQL-Struktur für die SQLite-Datenbank ---
*/
const SQL_TABLE_CREATION_COMMANDS = `
    CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        sku TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        batch_number TEXT UNIQUE NOT NULL,
        expiry_date DATE,
        quantity INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products (id)
    );

    CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shopify_order_id TEXT UNIQUE NOT NULL,
        customer_name TEXT,
        order_date DATE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_line_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        batch_id INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders (id),
        FOREIGN KEY (product_id) REFERENCES products (id),
        FOREIGN KEY (batch_id) REFERENCES batches (id)
    );
`;


// --- API Endpunkte ---

/**
 * GET /
 * Health-Check-Endpunkt, damit Render den Status des Dienstes überprüfen kann.
 */
app.get('/', (req, res) => {
    res.status(200).send('Batch Tracking Backend is running.');
});


/**
 * POST /api/batches
 * Erstellt eine neue Charge für ein Produkt in der Datenbank.
 * Body-Format: { "productId": 1, "batchNumber": "HON-2025-A1", "expiryDate": "2025-12-31", "quantity": 100 }
 */
app.post('/api/batches', (req, res) => {
    const { productId, batchNumber, expiryDate, quantity } = req.body;

    if (!productId || !batchNumber || !quantity) {
        return res.status(400).json({ message: 'productId, batchNumber und quantity sind erforderlich.' });
    }

    const query = `
        INSERT INTO batches (product_id, batch_number, expiry_date, quantity)
        VALUES (?, ?, ?, ?);
    `;
    const params = [productId, batchNumber, expiryDate, quantity];

    // db.run führt eine Abfrage aus, gibt aber keine Zeilen zurück.
    // Der zweite Parameter 'this' im Callback enthält Metadaten wie die ID der letzten eingefügten Zeile.
    db.run(query, params, function (err) {
        if (err) {
            console.error('Fehler beim Erstellen der Charge:', err.message);
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.status(409).json({ message: `Eine Charge mit der Nummer ${batchNumber} existiert bereits.` });
            }
            return res.status(500).json({ message: 'Interner Serverfehler' });
        }
        res.status(201).json({ message: 'Charge erfolgreich erstellt.', batchId: this.lastID });
    });
});


/**
 * POST /api/orders
 * Erstellt eine neue Bestellung und verknüpft die Artikel mit spezifischen Chargen.
 * Body-Format: { "shopifyOrderId": "SH-1004", "customerName": "Jane Doe", "orderDate": "2025-08-04", "lineItems": [{ "productId": 1, "batchId": 1, "quantity": 5 }] }
 */
app.post('/api/orders', (req, res) => {
    const { shopifyOrderId, customerName, orderDate, lineItems } = req.body;

    if (!shopifyOrderId || !lineItems || lineItems.length === 0) {
        return res.status(400).json({ message: 'shopifyOrderId und mindestens ein lineItem sind erforderlich.' });
    }
    
    // db.serialize stellt sicher, dass die Befehle nacheinander ausgeführt werden (wichtig für Transaktionen).
    db.serialize(() => {
        db.run('BEGIN TRANSACTION;');

        const orderQuery = `INSERT INTO orders (shopify_order_id, customer_name, order_date) VALUES (?, ?, ?)`;
        db.run(orderQuery, [shopifyOrderId, customerName, orderDate], function(err) {
            if (err) {
                db.run('ROLLBACK;');
                console.error('Fehler beim Erstellen der Bestellung:', err.message);
                return res.status(500).json({ message: 'Interner Serverfehler beim Erstellen der Bestellung.' });
            }
            
            const newOrderId = this.lastID;
            const itemPromises = lineItems.map(item => {
                return new Promise((resolve, reject) => {
                    const lineItemQuery = `INSERT INTO order_line_items (order_id, product_id, batch_id, quantity) VALUES (?, ?, ?, ?)`;
                    db.run(lineItemQuery, [newOrderId, item.productId, item.batchId, item.quantity], (err) => {
                        if (err) return reject(err);
                        
                        const updateBatchQuery = `UPDATE batches SET quantity = quantity - ? WHERE id = ?`;
                        db.run(updateBatchQuery, [item.quantity, item.batchId], (err) => {
                            if (err) return reject(err);
                            resolve();
                        });
                    });
                });
            });

            Promise.all(itemPromises)
                .then(() => {
                    db.run('COMMIT;');
                    res.status(201).json({ message: 'Bestellung erfolgreich erstellt.', orderId: newOrderId });
                })
                .catch(err => {
                    db.run('ROLLBACK;');
                    console.error('Fehler bei der Verarbeitung der Line Items:', err.message);
                    res.status(500).json({ message: 'Interner Serverfehler bei der Verarbeitung der Artikel.' });
                });
        });
    });
});


/**
 * GET /api/orders/batch/:batchNumber
 * Findet alle Bestellungen, die eine bestimmte Charge enthalten, durch eine DB-Abfrage.
 */
app.get('/api/orders/batch/:batchNumber', (req, res) => {
    const { batchNumber } = req.params;

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
        WHERE b.batch_number = ?;
    `;

    // db.all führt eine Abfrage aus und gibt alle gefundenen Zeilen im Callback zurück.
    db.all(query, [batchNumber], (err, rows) => {
        if (err) {
            console.error('Fehler bei der Suche nach Bestellungen:', err.message);
            return res.status(500).json({ message: 'Interner Serverfehler' });
        }
        if (rows.length === 0) {
            return res.status(404).json({ message: `Keine Bestellungen für Charge ${batchNumber} gefunden.` });
        }
        res.json({
            batchNumber: batchNumber,
            orders: rows
        });
    });
});


// --- Server starten ---
app.listen(port, () => {
    console.log(`Backend mit SQLite-Datenbank läuft auf http://localhost:${port}`);
});
