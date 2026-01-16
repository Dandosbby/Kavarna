const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Data directory for local fallback
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
const dataFile = path.join(dataDir, 'answers.json');
const couponFile = path.join(dataDir, 'coupons.json');

// Helper to read/write local files
function readLocal(file) {
    if (!fs.existsSync(file)) return [];
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return []; }
}
function writeLocal(file, data) {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) {
        console.error(`Local write failed (expected on Vercel): ${e.message}`);
    }
}

// Database Configuration
let pool = null;
const isDbConfigured = !!(process.env.DATABASE_URL || process.env.PGHOST) && process.env.DISABLE_DB !== 'true';

if (isDbConfigured) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL || `postgresql://${process.env.PGUSER}:${process.env.PGPASSWORD}@${process.env.PGHOST}:${process.env.PGPORT}/${process.env.PGDATABASE}`,
        ssl: { rejectUnauthorized: false }
    });
}

// Initialize Database Tables & Validate Connection
async function initDb() {
    if (!pool) return;
    try {
        // Test connection
        await pool.query('SELECT 1');

        await pool.query(`CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, date TEXT, time TEXT, answer TEXT, note TEXT, service_note TEXT, coupon_code TEXT, coupon_value TEXT);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS coupons (code TEXT PRIMARY KEY, value TEXT, used BOOLEAN DEFAULT FALSE, feedback_id TEXT);`);
        console.log('Database connected and tables initialized');
    } catch (err) {
        console.error('Database connection failed. Falling back to local files. Error:', err.message);
        pool = null; // Disable pool so app uses local fallback
    }
}
initDb();

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Endpoint to Save Feedback
app.post('/api/feedback', async (req, res) => {
    const { answer, note, serviceNote } = req.body;
    if (!answer) return res.status(400).json({ error: 'Missing answer' });

    let couponCode = null;
    let couponValue = null;
    const now = new Date();
    const feedbackId = Date.now().toString(36) + Math.random().toString(36).substr(2);

    try {
        if (pool) {
            const couponsRes = await pool.query('SELECT * FROM coupons WHERE feedback_id IS NULL');
            if (answer === 'ANO' && Math.random() < 0.01 && couponsRes.rows[0]) {
                couponCode = couponsRes.rows[0].code;
                couponValue = couponsRes.rows[0].value;
            }
            await pool.query('INSERT INTO feedback (id, date, time, answer, note, service_note, coupon_code, coupon_value) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
                [feedbackId, now.toLocaleDateString(), now.toLocaleTimeString(), answer, note || '', serviceNote || '', couponCode, couponValue]);
            if (couponCode) await pool.query('UPDATE coupons SET feedback_id = $1 WHERE code = $2', [feedbackId, couponCode]);
        } else {
            // Fallback to local
            const coupons = readLocal(couponFile);
            if (answer === 'ANO' && Math.random() < 0.01) {
                const available = coupons.find(c => !c.feedbackId);
                if (available) {
                    couponCode = available.code;
                    couponValue = available.value;
                    available.feedbackId = feedbackId;
                    writeLocal(couponFile, coupons);
                }
            }
            const feedbacks = readLocal(dataFile);
            feedbacks.push({ id: feedbackId, date: now.toLocaleDateString(), time: now.toLocaleTimeString(), answer, note, serviceNote, couponCode, couponValue });
            writeLocal(dataFile, feedbacks);
        }
        res.json({ success: true, couponCode, couponValue });
    } catch (err) {
        console.error('Save error:', err.message);
        res.json({ success: true, couponCode: null, status: 'error-but-swallowed' });
    }
});

// Admin Authentication Wrapper
function checkAuth(req, res, next) {
    const password = req.body.password || req.headers['x-admin-password'];
    if (password === '6767') return next();
    res.status(401).json({ error: 'Incorrect Password' });
}

// Admin Endpoint: Get All Data
app.post('/api/admin/data', checkAuth, async (req, res) => {
    try {
        if (pool) {
            const result = await pool.query('SELECT * FROM feedback ORDER BY id DESC');
            return res.json(result.rows.map(item => ({ ...item, serviceNote: item.service_note, couponCode: item.coupon_code, couponValue: item.coupon_value })));
        }
        res.json(readLocal(dataFile).reverse());
    } catch (err) {
        res.status(500).json({ error: `Database Error: ${err.message}` });
    }
});

app.post('/api/admin/coupons', checkAuth, async (req, res) => {
    try {
        if (pool) return res.json((await pool.query('SELECT * FROM coupons')).rows);
        res.json(readLocal(couponFile));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/coupons/add', async (req, res) => {
    const { code, value } = req.body;
    try {
        if (pool) {
            await pool.query('INSERT INTO coupons (code, value, used) VALUES ($1, $2, $3)', [code, value || 'Dárek pro Vás', false]);
        } else {
            const coupons = readLocal(couponFile);
            if (coupons.find(c => c.code === code)) return res.status(400).json({ error: 'Already exists' });
            coupons.push({ code, value, used: false, feedbackId: null });
            writeLocal(couponFile, coupons);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/coupons/:code', async (req, res) => {
    const { code } = req.params;
    try {
        if (pool) {
            const check = await pool.query('SELECT feedback_id FROM coupons WHERE code = $1', [code]);
            if (check.rows[0]?.feedback_id) return res.status(400).json({ error: 'Issued' });
            await pool.query('DELETE FROM coupons WHERE code = $1', [code]);
        } else {
            let coupons = readLocal(couponFile);
            coupons = coupons.filter(c => c.code !== code);
            writeLocal(couponFile, coupons);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/coupons/:code/toggle', async (req, res) => {
    const { code } = req.params;
    try {
        if (pool) {
            const result = await pool.query('UPDATE coupons SET used = NOT used WHERE code = $1 RETURNING used', [code]);
            return res.json({ success: true, used: result.rows[0].used });
        }
        const coupons = readLocal(couponFile);
        const c = coupons.find(i => i.code === code);
        if (c) c.used = !c.used;
        writeLocal(couponFile, coupons);
        res.json({ success: true, used: c?.used });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/data/:id', checkAuth, async (req, res) => {
    const { id } = req.params;
    try {
        if (pool) await pool.query('DELETE FROM feedback WHERE id = $1', [id]);
        else writeLocal(dataFile, readLocal(dataFile).filter(l => l.id !== id));
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
