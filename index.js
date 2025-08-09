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
    const scopes = 'read_products'; // Die Berechtigungen, die wir benötigen
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

    // HMAC-Verifizierung (Sicherheitscheck)
    const map = { ...req.query };
    delete map['hmac'];
    const message = new URLSearchParams(map).toString();
    const providedHmac = Buffer.from(hmac, 'hex');
    const generatedHmac = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(message).digest();

    if (!crypto.timingSafeEqual(providedHmac, generatedHmac)) {
        return res.status(400).send('HMAC validation failed');
    }

    // Schritt 3: Temporären Code gegen permanenten Access Token tauschen
    try {
        const accessTokenResponse = await axios.post(`https://${shop}/admin/oauth/access_token`, {
            client_id: SHOPIFY_API_KEY,
            client_secret: SHOPIFY_API_SECRET,
            code,
        });

        const accessToken = accessTokenResponse.data.access_token;

        // Schritt 4: Access Token sicher in der DB speichern
        const storeQuery = `
            INSERT INTO installations (shop, access_token) VALUES ($1, $2)
            ON CONFLICT (shop) DO UPDATE SET access_token = $2;
        `;
        await pool.query(storeQuery, [shop, accessToken]);

        // Schritt 5: Nutzer zur App im Shopify Admin weiterleiten
        res.redirect(`https://${shop}/admin/apps/shopify-lottracker-frontend`);

    } catch (error) {
        console.error('Error getting access token:', error.response ? error.response.data : error.message);
        res.status(500).send('Error getting access token.');
    }
});


// Die bestehende API bleibt gleich, wird aber weiterhin durch den JWT-Token aus dem Frontend geschützt.
const apiRouter = express.Router();
// ... (Restlicher API-Code von Version v4 bleibt hier unverändert) ...
app.use('/api', apiRouter);


// --- Server starten ---
app.listen(port, () => console.log(`Backend (v5 mit OAuth) läuft auf Port ${port}.`));
