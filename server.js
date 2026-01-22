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
const cooldownFile = path.join(dataDir, 'cooldowns.json');

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
                await client.query('SELECT 1');
                await client.query(`CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, date TEXT, time TEXT, answer TEXT, note TEXT, service_note TEXT, coupon_code TEXT, coupon_value TEXT, responses JSONB);`);
                await client.query(`CREATE TABLE IF NOT EXISTS coupons (code TEXT PRIMARY KEY, value TEXT, used BOOLEAN DEFAULT FALSE, feedback_id TEXT);`);
                await client.query(`CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, text TEXT, order_index INTEGER, allow_note BOOLEAN DEFAULT TRUE, yes_prompt TEXT, no_prompt TEXT, placeholder TEXT, type TEXT DEFAULT 'yes_no');`);
                await client.query(`CREATE TABLE IF NOT EXISTS ip_cooldowns (ip TEXT, date TEXT, PRIMARY KEY (ip, date));`);
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
    { id: 'q1', text: 'Chutnala Vám káva? ☕️', allowNote: true, yesPrompt: 'Máte pro nás nějaký postřeh? ✨', noPrompt: 'Mrzí nás to. 😔 Chcete nám říct proč?', placeholder: 'Vaše zpráva...', type: 'yes_no' },
    { id: 'q2', text: 'Chcete ohodnotit dnešní obsluhu? ☕️', allowNote: true, yesPrompt: 'Máte pro nás nějaký postřeh? ✨', noPrompt: 'Mrzí nás to. 😔 Chcete nám říct proč?', placeholder: 'Vaše zpráva...', type: 'stars' }
];

async function getQuestions() {
    if (dbType === 'kv') return (await kv.get('questions')) || defaultQuestions;
    if (dbType === 'pg') {
        try {
            const res = await pool.query('SELECT * FROM questions ORDER BY order_index ASC');
            return res.rows.length > 0 ? res.rows.map(q => ({
                ...q,
                allowNote: q.allow_note,
                yesPrompt: q.yes_prompt,
                noPrompt: q.no_prompt,
                placeholder: q.placeholder,
                type: q.type || 'yes_no'
            })) : defaultQuestions;
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
            await pool.query('INSERT INTO questions (id, text, order_index, allow_note, yes_prompt, no_prompt, placeholder, type) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
                [questions[i].id, questions[i].text, i, !!questions[i].allowNote, questions[i].yesPrompt || '', questions[i].noPrompt || '', questions[i].placeholder || '', questions[i].type || 'yes_no']);
        }
    } else writeLocal(questionFile, questions);
}

// --- Cooldown Helpers ---
async function checkCooldown(ip) {
    const today = new Date().toISOString().split('T')[0];
    if (dbType === 'kv') {
        const cooldowns = (await kv.get('cooldowns')) || {};
        return cooldowns[ip] === today;
    }
    if (dbType === 'pg') {
        const res = await pool.query('SELECT 1 FROM ip_cooldowns WHERE ip = $1 AND date = $2', [ip, today]);
        return res.rows.length > 0;
    }
    let cooldowns = readLocal(cooldownFile);
    if (Array.isArray(cooldowns)) cooldowns = {};
    return cooldowns[ip] === today;
}

async function setCooldown(ip) {
    const today = new Date().toISOString().split('T')[0];
    if (dbType === 'kv') {
        const cooldowns = (await kv.get('cooldowns')) || {};
        cooldowns[ip] = today;
        await kv.set('cooldowns', cooldowns);
    } else if (dbType === 'pg') {
        await pool.query('INSERT INTO ip_cooldowns (ip, date) VALUES ($1, $2) ON CONFLICT (ip, date) DO NOTHING', [ip, today]);
    } else {
        let cooldowns = readLocal(cooldownFile);
        if (Array.isArray(cooldowns)) cooldowns = {};
        cooldowns[ip] = today;
        writeLocal(cooldownFile, cooldowns);
    }
}

// Endpoint to Save Feedback
app.post('/api/feedback', async (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const isLocal = ip === '::1' || ip === '127.0.0.1';

    // Check cooldown (skip for local testing if desired, but here we enforce it)
    const onCooldown = await checkCooldown(ip);
    if (onCooldown) {
        return res.status(429).json({ success: false, error: 'Dnes jste již hodnocení odeslali. Děkujeme!' });
    }

    const { answer, note, serviceNote, responses } = req.body;

    let couponCode = null;
    let couponValue = null;
    const now = new Date();
    const feedbackId = Date.now().toString(36) + Math.random().toString(36).substr(2);

    try {
        const coupons = await getCoupons();
        const available = coupons.filter(c => !c.feedbackId && !c.used);

        // Logic to win a real coupon from admin pool
        // Using a reasonable chance (e.g. 20%) if coupons exist
        if (available.length > 0 && Math.random() < 0.2) {
            const index = Math.floor(Math.random() * available.length);
            const prize = available[index];
            couponCode = prize.code;
            couponValue = prize.value;

            if (dbType === 'pg') {
                await pool.query('UPDATE coupons SET feedback_id = $1 WHERE code = $2', [feedbackId, couponCode]);
            } else {
                prize.feedbackId = feedbackId;
                await saveCoupons(coupons);
            }
        }

        const entry = {
            id: feedbackId,
            date: now.toLocaleDateString(),
            time: now.toLocaleTimeString(),
            answer: answer || '',
            note: note || '',
            serviceNote: serviceNote || '',
            couponCode,
            couponValue,
            responses: responses || {}
        };
        await saveFeedback(entry);

        // Set cooldown after successful save
        await setCooldown(ip);

        res.json({ success: true, couponCode, couponValue });
    } catch (err) {
        console.error('Save error:', err.message);
        res.status(500).json({ error: 'Failed to save feedback' });
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

app.get('/api/public-stats', async (req, res) => {
    try {
        const feedbacks = await getFeedbacks();
        const questions = await getQuestions();

        const starQuestions = questions.filter(q => q.type === 'stars');
        let totalStars = 0;
        let starCount = 0;

        feedbacks.forEach(f => {
            starQuestions.forEach(q => {
                const val = parseFloat(f.responses?.[q.id]?.answer);
                if (!isNaN(val)) {
                    totalStars += val;
                    starCount++;
                }
            });
        });

        const avgStars = starCount > 0 ? (totalStars / starCount).toFixed(1) : "0.0";

        res.json({
            count: feedbacks.length,
            averageStars: avgStars
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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

app.delete('/api/admin/data/all', checkAuth, async (req, res) => {
    try {
        if (dbType === 'pg') await pool.query('DELETE FROM feedback');
        else if (dbType === 'kv') await kv.set('feedbacks', []);
        else writeLocal(dataFile, []);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/cooldowns/reset', checkAuth, async (req, res) => {
    try {
        if (dbType === 'pg') await pool.query('DELETE FROM ip_cooldowns');
        else if (dbType === 'kv') await kv.set('cooldowns', {});
        else writeLocal(cooldownFile, {});
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/data/batch/20', checkAuth, async (req, res) => {
    try {
        if (dbType === 'pg') {
            await pool.query('DELETE FROM feedback WHERE id IN (SELECT id FROM feedback ORDER BY id DESC LIMIT 20)');
        } else if (dbType === 'kv') {
            let data = await getFeedbacks();
            data.splice(0, 20); // Remove first 20 (since we reverse for display, or just newest)
            await kv.set('feedbacks', data);
        } else {
            let data = readLocal(dataFile);
            data.splice(data.length - 20, 20); // Remove last 20 from local file
            writeLocal(dataFile, data);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/data/:id', checkAuth, async (req, res) => {
    const { id } = req.params;
    try {
        if (dbType === 'pg') await pool.query('DELETE FROM feedback WHERE id = $1', [id]);
        else if (dbType === 'kv') {
            let data = await getFeedbacks();
            data = data.filter(l => l.id !== id);
            await kv.set('feedbacks', data);
        } else {
            let data = readLocal(dataFile);
            data = data.filter(l => l.id !== id);
            writeLocal(dataFile, data);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/data/mock', checkAuth, async (req, res) => {
    try {
        const mockEntries = [];
        const answers = ['ANO', 'NE'];
        const notes = ['Super káva!', 'Příliš horké', 'Dokonalá pěna', 'Trošku hořké', 'Nejlepší v okolí', 'Obsluha byla pomalá', 'Krásné prostředí', 'Doporučuji!'];
        const serviceNotes = ['Velmi milá slečna', 'Čekal jsem dlouho', 'Bez problémů', 'Skvělý přístup', 'Příště přijdu zas'];

        for (let i = 0; i < 20; i++) {
            const date = new Date(Date.now() - Math.random() * 1000 * 60 * 60 * 24 * 7);
            const ans = answers[Math.floor(Math.random() * answers.length)];
            mockEntries.push({
                id: Math.random().toString(36).substr(2, 9),
                date: date.toLocaleDateString(),
                time: date.toLocaleTimeString(),
                answer: ans,
                note: ans === 'NE' ? notes[Math.floor(Math.random() * notes.length)] : '',
                serviceNote: Math.random() > 0.5 ? serviceNotes[Math.floor(Math.random() * serviceNotes.length)] : '',
                couponCode: Math.random() > 0.8 ? 'MOCK-' + Math.random().toString(36).substr(2, 5).toUpperCase() : null,
                couponValue: 'Zkušební sleva'
            });
        }

        if (dbType === 'kv') {
            const current = await getFeedbacks();
            await kv.set('feedbacks', [...current, ...mockEntries]);
        } else if (dbType === 'pg') {
            for (const entry of mockEntries) {
                await pool.query('INSERT INTO feedback (id, date, time, answer, note, service_note, coupon_code, coupon_value) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
                    [entry.id, entry.date, entry.time, entry.answer, entry.note, entry.serviceNote, entry.couponCode, entry.couponValue]);
            }
        } else {
            const current = readLocal(dataFile);
            writeLocal(dataFile, [...current, ...mockEntries]);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log(`Server is running ${dbType} on port ${PORT}`));
