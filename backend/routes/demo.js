const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const { signToken } = require('../middleware/auth');
const { generateTransactions } = require('../lib/seed');

const router = express.Router();

const demoLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: config.isTest ? 100000 : 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many demo accounts created from this address. Try again later.' },
});

/**
 * Provisions a throwaway account seeded with a year of fictional transactions
 * and returns a token for it.
 *
 * The point is that someone evaluating this can see a populated dashboard in
 * one click rather than an empty state behind a signup form.
 */
router.post('/', demoLimiter, async (req, res, next) => {
    const suffix = crypto.randomBytes(6).toString('hex');
    const username = `demo-${suffix}`;
    const email = `${username}@demo.local`;

    try {
        // Random password, never shown: the account is reachable only through
        // the token returned here.
        const password = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);

        const result = await db.run(
            'INSERT INTO users (username, email, password, is_demo) VALUES (?, ?, ?, 1)',
            [username, email, password]
        );
        const userId = result.lastID;

        const transactions = generateTransactions({ months: 12 });

        await db.run('BEGIN');
        for (const t of transactions) {
            await db.run(
                `INSERT OR IGNORE INTO transactions
                    (user_id, description, amount_cents, type, category, date, dedupe_hash, category_source)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'user')`,
                [userId, t.description, t.amountCents, t.type, t.category, t.date, t.dedupeHash]
            );
        }
        await db.run('COMMIT');

        const user = { id: userId, username, email };
        res.status(201).json({
            token: signToken(user),
            user: { ...user, is_demo: 1 },
            seeded: transactions.length,
        });
    } catch (err) {
        await db.run('ROLLBACK').catch(() => {});
        next(err);
    }
});

module.exports = router;
