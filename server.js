const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const { kv } = require('@vercel/kv');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Data directory for local fallback
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
const dataFile = path.join(dataDir, 'answers.json');
const couponFile = path.join(dataDir, 'coupons.json');
const questionFile = path.join(dataDir, 'questions.json');

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

// Storage Configuration
let dbType = 'local';
let pool = null;

if (process.env.KV_URL && process.env.DISABLE_KV !== 'true') {
    dbType = 'kv';
    console.log('Using Vercel KV for storage');
} else if ((process.env.DATABASE_URL || process.env.PGHOST) && process.env.DISABLE_DB !== 'true') {
    dbType = 'pg';
    pool = new Pool({
        connectionString: process.env.DATABASE_URL || `postgresql://${process.env.PGUSER}:${process.env.PGPASSWORD}@${process.env.PGHOST}:${process.env.PGPORT}/${process.env.PGDATABASE}`,
        ssl: { rejectUnauthorized: false }
    });
    console.log('Using PostgreSQL for storage');
} else {
    console.log('Using Local Files for storage');
}

// Initialize Database Tables & Validate Connection
async function initDb() {
    if (dbType === 'pg' && pool) {
        try {
            const client = await pool.connect();
            try {
                await pool.query('SELECT 1');
                await client.query(`CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, date TEXT, time TEXT, answer TEXT, note TEXT, service_note TEXT, coupon_code TEXT, coupon_value TEXT, responses JSONB);`);
                await client.query(`CREATE TABLE IF NOT EXISTS coupons (code TEXT PRIMARY KEY, value TEXT, used BOOLEAN DEFAULT FALSE, feedback_id TEXT);`);
                await client.query(`CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, text TEXT, order_index INTEGER, allow_note BOOLEAN DEFAULT TRUE);`);
                console.log('PostgreSQL tables initialized');
            } finally {
                client.release();
            }
        } catch (err) {
            console.error('PostgreSQL connection failed. Falling back to local. Error:', err.message);
            dbType = 'local';
            pool = null;
        }
    } else if (dbType === 'kv') {
        try {
            await kv.set('test_connection', 'ok');
            console.log('Vercel KV connection verified');
        } catch (err) {
            console.error('Vercel KV connection failed. Falling back to local. Error:', err.message);
            dbType = 'local';
        }
    }
}
initDb();

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- Storage Wrappers ---
async function getFeedbacks() {
    if (dbType === 'kv') return (await kv.get('feedbacks')) || [];
    if (dbType === 'pg') return (await pool.query('SELECT * FROM feedback ORDER BY id DESC')).rows.map(item => ({ ...item, serviceNote: item.service_note, couponCode: item.coupon_code, couponValue: item.coupon_value }));
    return readLocal(dataFile);
}

async function saveFeedback(entry) {
    if (dbType === 'kv') {
        const feedbacks = await getFeedbacks();
        feedbacks.push(entry);
        await kv.set('feedbacks', feedbacks);
    } else if (dbType === 'pg') {
        await pool.query('INSERT INTO feedback (id, date, time, answer, note, service_note, coupon_code, coupon_value, responses) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
            [entry.id, entry.date, entry.time, entry.answer || '', entry.note || '', entry.serviceNote || '', entry.couponCode, entry.couponValue, JSON.stringify(entry.responses || {})]);
    } else {
        const feedbacks = readLocal(dataFile);
        feedbacks.push(entry);
        writeLocal(dataFile, feedbacks);
    }
}

async function getCoupons() {
    if (dbType === 'kv') return (await kv.get('coupons')) || [];
    if (dbType === 'pg') return (await pool.query('SELECT * FROM coupons')).rows;
    return readLocal(couponFile);
}

async function saveCoupons(coupons) {
    if (dbType === 'kv') await kv.set('coupons', coupons);
    else if (dbType === 'pg') {
        // PG uses individual row management
    } else writeLocal(couponFile, coupons);
}

const defaultQuestions = [
    { id: 'q1', text: 'Chutnala Vám káva? ☕️', allowNote: true },
    { id: 'q2', text: 'Chcete ohodnotit dnešní obsluhu? ☕️', allowNote: true }
];

async function getQuestions() {
    if (dbType === 'kv') return (await kv.get('questions')) || defaultQuestions;
    if (dbType === 'pg') {
        try {
            const res = await pool.query('SELECT * FROM questions ORDER BY order_index ASC');
            return res.rows.length > 0 ? res.rows.map(q => ({ ...q, allowNote: q.allow_note })) : defaultQuestions;
        } catch (e) { return defaultQuestions; }
    }
    const local = readLocal(questionFile);
    return local.length > 0 ? local : defaultQuestions;
}

async function saveQuestions(questions) {
    if (dbType === 'kv') await kv.set('questions', questions);
    else if (dbType === 'pg') {
        await pool.query('DELETE FROM questions');
        for (let i = 0; i < questions.length; i++) {
            await pool.query('INSERT INTO questions (id, text, order_index, allow_note) VALUES ($1, $2, $3, $4)', [questions[i].id, questions[i].text, i, !!questions[i].allowNote]);
        }
    } else writeLocal(questionFile, questions);
}

// Endpoint to Save Feedback
app.post('/api/feedback', async (req, res) => {
    const { answer, note, serviceNote } = req.body;
    if (!answer) return res.status(400).json({ error: 'Missing answer' });

    let couponCode = null;
    let couponValue = null;
    const now = new Date();
    const feedbackId = Date.now().toString(36) + Math.random().toString(36).substr(2);

    try {
        const coupons = await getCoupons();
        const available = coupons.find(c => !c.feedbackId);

        if (answer === 'ANO' && Math.random() < 0.01 && available) {
            couponCode = available.code;
            couponValue = available.value;
            available.feedbackId = feedbackId;
            if (dbType === 'pg') {
                await pool.query('UPDATE coupons SET feedback_id = $1 WHERE code = $2', [feedbackId, couponCode]);
            } else {
                await saveCoupons(coupons);
            }
        }

        const entry = { id: feedbackId, date: now.toLocaleDateString(), time: now.toLocaleTimeString(), answer, note, serviceNote, couponCode, couponValue };
        await saveFeedback(entry);

        res.json({ success: true, couponCode, couponValue });
    } catch (err) {
        console.error('Save error:', err.message);
        res.json({ success: true, couponCode: null, status: 'error-swallowed' });
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
        const data = await getFeedbacks();
        res.json(dbType === 'local' || dbType === 'kv' ? [...data].reverse() : data);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/questions', async (req, res) => {
    try { res.json(await getQuestions()); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/questions', checkAuth, async (req, res) => {
    try {
        const { questions } = req.body;
        if (!Array.isArray(questions)) return res.status(400).json({ error: 'Questions must be an array' });
        await saveQuestions(questions);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/coupons', checkAuth, async (req, res) => {
    try { res.json(await getCoupons()); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/coupons/add', async (req, res) => {
    const { code, value } = req.body;
    try {
        if (dbType === 'pg') {
            await pool.query('INSERT INTO coupons (code, value, used) VALUES ($1, $2, $3)', [code, value || 'Dárek pro Vás', false]);
        } else {
            const coupons = await getCoupons();
            if (coupons.find(c => c.code === code)) return res.status(400).json({ error: 'Already exists' });
            coupons.push({ code, value, used: false, feedbackId: null });
            await saveCoupons(coupons);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/coupons/:code', async (req, res) => {
    const { code } = req.params;
    try {
        if (dbType === 'pg') {
            const check = await pool.query('SELECT feedback_id FROM coupons WHERE code = $1', [code]);
            if (check.rows[0]?.feedback_id) return res.status(400).json({ error: 'Issued' });
            await pool.query('DELETE FROM coupons WHERE code = $1', [code]);
        } else {
            let coupons = await getCoupons();
            const c = coupons.find(i => i.code === code);
            if (c?.feedbackId) return res.status(400).json({ error: 'Issued' });
            coupons = coupons.filter(c => c.code !== code);
            await saveCoupons(coupons);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/coupons/:code/toggle', async (req, res) => {
    const { code } = req.params;
    try {
        if (dbType === 'pg') {
            const result = await pool.query('UPDATE coupons SET used = NOT used WHERE code = $1 RETURNING used', [code]);
            return res.json({ success: true, used: result.rows[0].used });
        }
        const coupons = await getCoupons();
        const c = coupons.find(i => i.code === code);
        if (c) {
            c.used = !c.used;
            await saveCoupons(coupons);
        }
        res.json({ success: true, used: c?.used });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/data/:id', checkAuth, async (req, res) => {
    const { id } = req.params;
    try {
        if (dbType === 'pg') await pool.query('DELETE FROM feedback WHERE id = $1', [id]);
        else {
            let data = await getFeedbacks();
            data = data.filter(l => l.id !== id);
            await kv.set('feedbacks', data); // Since KV/Local use list strategy
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log(`Server is running ${dbType} on port ${PORT}`));
