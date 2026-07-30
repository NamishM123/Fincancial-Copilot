const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const { signToken } = require('../middleware/auth');

const router = express.Router();

// Without this, a 6-character minimum password is trivially brute-forceable.
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: config.isTest ? 10000 : 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please try again in a few minutes.' },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/register', authLimiter, async (req, res, next) => {
    const { username, email, password } = req.body || {};

    if (!username || !email || !password) {
        return res.status(400).json({ error: 'Username, email, and password are all required' });
    }
    if (!EMAIL_RE.test(email)) {
        return res.status(400).json({ error: 'Please enter a valid email address' });
    }
    if (String(password).length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (String(username).length > 50 || String(email).length > 200) {
        return res.status(400).json({ error: 'Username or email is too long' });
    }

    try {
        const hashed = await bcrypt.hash(String(password), 10);
        const result = await db.run(
            'INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
            [String(username).trim(), String(email).trim().toLowerCase(), hashed]
        );

        const user = { id: result.lastID, username: String(username).trim(), email: String(email).trim().toLowerCase() };
        res.status(201).json({ token: signToken(user), user });
    } catch (err) {
        if (err.message && err.message.includes('UNIQUE constraint failed')) {
            const field = err.message.includes('email') ? 'Email' : 'Username';
            return res.status(409).json({ error: `${field} is already registered` });
        }
        next(err);
    }
});

router.post('/login', authLimiter, async (req, res, next) => {
    const { email, password } = req.body || {};

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
        const user = await db.get('SELECT * FROM users WHERE email = ?', [String(email).trim().toLowerCase()]);

        // Same message and comparable timing whether or not the account exists,
        // so this endpoint can't be used to enumerate registered emails.
        const hash = user ? user.password : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvaliduu';
        const valid = await bcrypt.compare(String(password), hash);

        if (!user || !valid) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        res.json({
            token: signToken(user),
            user: { id: user.id, username: user.username, email: user.email },
        });
    } catch (err) {
        next(err);
    }
});

router.get('/me', require('../middleware/auth').authenticateToken, async (req, res, next) => {
    try {
        const user = await db.get('SELECT id, username, email, is_demo FROM users WHERE id = ?', [req.user.userId]);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ user });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
