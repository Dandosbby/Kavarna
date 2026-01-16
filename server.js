const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Database Configuration
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || `postgresql://${process.env.PGUSER}:${process.env.PGPASSWORD}@${process.env.PGHOST}:${process.env.PGPORT}/${process.env.PGDATABASE}`,
    ssl: {
        rejectUnauthorized: false // Required for Aurora/RDS often
    }
});

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Initialize Database Tables
async function initDb() {
    const feedbackTable = `
        CREATE TABLE IF NOT EXISTS feedback (
            id TEXT PRIMARY KEY,
            date TEXT,
            time TEXT,
            answer TEXT,
            note TEXT,
            service_note TEXT,
            coupon_code TEXT,
            coupon_value TEXT
        );
    `;
    const couponsTable = `
        CREATE TABLE IF NOT EXISTS coupons (
            code TEXT PRIMARY KEY,
            value TEXT,
            used BOOLEAN DEFAULT FALSE,
            feedback_id TEXT
        );
    `;
    try {
        await pool.query(feedbackTable);
        await pool.query(couponsTable);
        console.log('Database tables initialized');
    } catch (err) {
        console.error('Error initializing database:', err.message);
    }
}
initDb();

// Endpoint to Save Feedback
app.post('/api/feedback', async (req, res) => {
    const { answer, note, serviceNote } = req.body;
    if (!answer) return res.status(400).json({ error: 'Missing answer' });

    try {
        // Get all coupons to check for availability
        const couponsRes = await pool.query('SELECT * FROM coupons WHERE feedback_id IS NULL');
        const coupons = couponsRes.rows;

        let couponCode = null;
        let couponValue = null;

        // Coupon Logic (1% chance for ANO answers)
        if (answer === 'ANO' && Math.random() < 0.01) {
            const availableCoupon = coupons[0]; // Simple pick first available
            if (availableCoupon) {
                couponCode = availableCoupon.code;
                couponValue = availableCoupon.value;
            }
        }

        const now = new Date();
        const feedbackId = Date.now().toString(36) + Math.random().toString(36).substr(2);

        // Save Feedback
        await pool.query(
            'INSERT INTO feedback (id, date, time, answer, note, service_note, coupon_code, coupon_value) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [feedbackId, now.toLocaleDateString(), now.toLocaleTimeString(), answer, note || '', serviceNote || '', couponCode, couponValue]
        );

        // Link coupon if assigned
        if (couponCode) {
            await pool.query('UPDATE coupons SET feedback_id = $1 WHERE code = $2', [feedbackId, couponCode]);
        }

        res.json({ success: true, couponCode: couponCode, couponValue: couponValue });
    } catch (err) {
        console.error('Database error:', err.message);
        // On Vercel, we still return success: true so the UI works, but we log the error
        res.json({ success: true, couponCode: null, couponValue: null, status: 'mocked due to db error' });
    }
});

// Admin Endpoint: Get All Data
app.post('/api/admin/data', async (req, res) => {
    const { password } = req.body;
    if (password !== '6767') return res.status(401).json({ error: 'Unauthorized' });

    try {
        const result = await pool.query('SELECT * FROM feedback ORDER BY id DESC');
        res.json(result.rows.map(item => ({
            date: item.date,
            time: item.time,
            answer: item.answer,
            note: item.note,
            serviceNote: item.service_note,
            couponCode: item.coupon_code,
            couponValue: item.coupon_value,
            id: item.id
        })));
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// Admin Coupons Pool Endpoint
app.post('/api/admin/coupons', async (req, res) => {
    const { password } = req.body;
    if (password !== '6767') return res.status(401).json({ error: 'Unauthorized' });

    try {
        const result = await pool.query('SELECT * FROM coupons');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// Add Coupon to Pool
app.post('/api/admin/coupons/add', async (req, res) => {
    const { code, value } = req.body;
    if (!code) return res.status(400).json({ error: 'Missing code' });

    try {
        await pool.query('INSERT INTO coupons (code, value, used) VALUES ($1, $2, $3)', [code, value || 'Dárek pro Vás', false]);
        res.json({ success: true });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: 'Coupon already exists' });
        res.status(500).json({ error: 'Database error' });
    }
});

// Delete Coupon from Pool
app.delete('/api/admin/coupons/:code', async (req, res) => {
    const { code } = req.params;
    try {
        const check = await pool.query('SELECT feedback_id FROM coupons WHERE code = $1', [code]);
        if (check.rows.length > 0 && check.rows[0].feedback_id) {
            return res.status(400).json({ error: 'Cannot delete issued coupon' });
        }
        await pool.query('DELETE FROM coupons WHERE code = $1', [code]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// Delete Feedback
app.delete('/api/admin/data/:id', async (req, res) => {
    const { id } = req.params;
    const password = req.headers['x-admin-password'];
    if (password !== '6767') return res.status(401).json({ error: 'Unauthorized' });

    try {
        await pool.query('DELETE FROM feedback WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// Toggle Coupon Status
app.post('/api/admin/coupons/:code/toggle', async (req, res) => {
    const { code } = req.params;
    try {
        const result = await pool.query('UPDATE coupons SET used = NOT used WHERE code = $1 RETURNING used', [code]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Coupon not found' });
        res.json({ success: true, used: result.rows[0].used });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
