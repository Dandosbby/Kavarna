const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
}
const dataFile = path.join(dataDir, 'answers.json');
const couponFile = path.join(dataDir, 'coupons.json');

// Helper to read data
function readData() {
    if (!fs.existsSync(dataFile)) return [];
    try {
        const data = fs.readFileSync(dataFile, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        return [];
    }
}

// Helper to read coupons
function readCoupons() {
    if (!fs.existsSync(couponFile)) return [];
    try {
        const data = fs.readFileSync(couponFile, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        return [];
    }
}

// Endpoint to Save Feedback
app.post('/api/feedback', (req, res) => {
    const { answer, note, serviceNote } = req.body;
    if (!answer) return res.status(400).json({ error: 'Missing answer' });

    const currentData = readData();
    const coupons = readCoupons();
    let couponCode = null;
    let couponValue = null;

    // Coupon Logic (1% chance for ANO answers, pick from pool)
    if (answer === 'ANO' && Math.random() < 0.01) {
        const availableCoupon = coupons.find(c => !c.feedbackId);
        if (availableCoupon) {
            couponCode = availableCoupon.code;
            couponValue = availableCoupon.value;
            // Temporary assignment
            availableCoupon.feedbackBaseId = Date.now().toString(36);
        }
    }

    const now = new Date();
    const feedbackId = Date.now().toString(36) + Math.random().toString(36).substr(2);

    // Finalize coupon assignment if any
    if (couponCode) {
        const coupon = coupons.find(c => c.code === couponCode);
        if (coupon) coupon.feedbackId = feedbackId;
        try {
            fs.writeFileSync(couponFile, JSON.stringify(coupons, null, 2));
        } catch (e) {
            console.error('Failed to write coupon file (expected on Vercel):', e.message);
        }
    }

    const entry = {
        date: now.toLocaleDateString(),
        time: now.toLocaleTimeString(),
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        answer: answer,
        note: note || '',
        serviceNote: serviceNote || '',
        couponCode: couponCode,
        couponValue: couponValue,
        id: feedbackId
    };

    currentData.push(entry);
    try {
        fs.writeFileSync(dataFile, JSON.stringify(currentData, null, 2));
    } catch (e) {
        console.error('Failed to write data file (expected on Vercel):', e.message);
    }

    res.json({ success: true, couponCode: couponCode, couponValue: couponValue });
});

// Admin Endpoint
app.post('/api/admin/data', (req, res) => {
    const { password } = req.body;
    if (password !== '6767') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const currentData = readData();
    const coupons = readCoupons();

    // Filter sensitive data
    const safeData = currentData.map(item => {
        const coupon = item.couponCode ? coupons.find(c => c.code === item.couponCode) : null;
        return {
            date: item.date,
            time: item.time,
            answer: item.answer,
            note: item.note, // Expose note
            serviceNote: item.serviceNote,
            couponCode: item.couponCode,
            couponValue: item.couponValue,
            couponUsed: coupon ? coupon.used : undefined,
            id: item.id
        };
    });


    res.json(safeData);
});

// Admin Coupons Pool Endpoint
app.post('/api/admin/coupons', (req, res) => {
    const { password } = req.body;
    if (password !== '6767') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const coupons = readCoupons();
    res.json(coupons);
});

// Add Coupon to Pool
app.post('/api/admin/coupons/add', (req, res) => {
    const { code, value } = req.body;
    // Removed password check as it's handled by generic auth usually or session
    // But since we use simple auth, let's keep it consistent with headers if needed
    // However user asked to remove verification for creating.

    if (!code) return res.status(400).json({ error: 'Missing code' });

    let coupons = readCoupons();
    if (coupons.find(c => c.code === code)) {
        return res.status(400).json({ error: 'Coupon already exists' });
    }

    coupons.push({
        code,
        value: value || 'Dárek pro Vás',
        used: false,
        feedbackId: null
    });
    fs.writeFileSync(couponFile, JSON.stringify(coupons, null, 2));
    res.json({ success: true });
});

// Delete Coupon from Pool
app.delete('/api/admin/coupons/:code', (req, res) => {
    // Removed password verification
    const { code } = req.params;
    let coupons = readCoupons();
    const couponIndex = coupons.findIndex(c => c.code === code);

    if (couponIndex === -1) {
        return res.status(404).json({ error: 'Coupon not found' });
    }

    if (coupons[couponIndex].feedbackId) {
        return res.status(400).json({ error: 'Cannot delete issued coupon' });
    }

    coupons.splice(couponIndex, 1);
    fs.writeFileSync(couponFile, JSON.stringify(coupons, null, 2));
    res.json({ success: true });
});

// Delete Endpoint
app.delete('/api/admin/data/:id', (req, res) => {
    const { id } = req.params;
    const password = req.headers['x-admin-password']; // logical place for password in DELETE

    if (password !== '6767') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    let currentData = readData();
    const newData = currentData.filter(item => item.id !== id);

    if (currentData.length === newData.length) {
        return res.status(404).json({ error: 'Item not found' });
    }

    fs.writeFileSync(dataFile, JSON.stringify(newData, null, 2));
    res.json({ success: true });
});

// Toggle Coupon Status Endpoint (Pool-based)
app.post('/api/admin/coupons/:code/toggle', (req, res) => {
    const { code } = req.params;
    // Removed password verification
    let coupons = readCoupons();
    const coupon = coupons.find(c => c.code === code);

    if (!coupon) {
        return res.status(404).json({ error: 'Coupon not found' });
    }

    coupon.used = !coupon.used;

    fs.writeFileSync(couponFile, JSON.stringify(coupons, null, 2));
    res.json({ success: true, used: coupon.used });
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
