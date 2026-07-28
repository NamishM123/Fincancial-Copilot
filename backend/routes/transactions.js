const express = require('express');
const db = require('../db');
const config = require('../config');
const { authenticateToken } = require('../middleware/auth');
const { toCents } = require('../lib/money');
const { dedupeHash } = require('../lib/dedupe');

const router = express.Router();
router.use(authenticateToken);

const VALID_TYPES = ['income', 'expense'];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Paginated. The previous unbounded query returned a user's entire history on
// every dashboard load.
router.get('/', async (req, res, next) => {
    const userId = req.user.userId;
    const limit = Math.min(
        Math.max(Number(req.query.limit) || config.limits.transactionPageSize, 1),
        config.limits.transactionPageSizeMax
    );
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    try {
        const [rows, countRow] = await Promise.all([
            db.all(
                'SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT ? OFFSET ?',
                [userId, limit, offset]
            ),
            db.get('SELECT COUNT(*) AS total FROM transactions WHERE user_id = ?', [userId]),
        ]);

        res.json({
            transactions: rows,
            pagination: {
                total: countRow.total,
                limit,
                offset,
                hasMore: offset + rows.length < countRow.total,
            },
        });
    } catch (err) {
        next(err);
    }
});

router.post('/', async (req, res, next) => {
    const userId = req.user.userId;
    const { description, amount, type, category, date } = req.body || {};

    if (!description || amount === undefined || !type || !category || !date) {
        return res.status(400).json({ error: 'Description, amount, type, category, and date are all required' });
    }
    if (!VALID_TYPES.includes(type)) {
        return res.status(400).json({ error: 'Type must be "income" or "expense"' });
    }
    if (!ISO_DATE_RE.test(date)) {
        return res.status(400).json({ error: 'Date must be in YYYY-MM-DD format' });
    }

    const amountCents = toCents(amount);
    if (amountCents === null || amountCents <= 0) {
        return res.status(400).json({ error: 'Amount must be a number greater than 0' });
    }

    const desc = String(description).trim().slice(0, 200);
    const cat = String(category).trim().slice(0, 60);
    const hash = dedupeHash({ date, description: desc, amountCents, type });

    try {
        const result = await db.run(
            `INSERT INTO transactions (user_id, description, amount_cents, type, category, date, dedupe_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [userId, desc, amountCents, type, cat, date, hash]
        );

        const created = await db.get('SELECT * FROM transactions WHERE id = ?', [result.lastID]);
        res.status(201).json({ transaction: created });
    } catch (err) {
        if (err.message && err.message.includes('UNIQUE constraint failed')) {
            return res.status(409).json({ error: 'An identical transaction already exists on that date' });
        }
        next(err);
    }
});

router.delete('/:id', async (req, res, next) => {
    try {
        // The `user_id` predicate is the authorization check. Without it, any
        // logged-in user could delete any row by guessing an id.
        const result = await db.run(
            'DELETE FROM transactions WHERE id = ? AND user_id = ?',
            [req.params.id, req.user.userId]
        );

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Transaction not found' });
        }
        res.json({ deleted: Number(req.params.id) });
    } catch (err) {
        next(err);
    }
});

router.get('/summary', async (req, res, next) => {
    const userId = req.user.userId;

    try {
        const [totals, categories] = await Promise.all([
            db.all(
                `SELECT type, SUM(amount_cents) AS total_cents, COUNT(*) AS count
                 FROM transactions WHERE user_id = ? GROUP BY type`,
                [userId]
            ),
            db.all(
                `SELECT category, SUM(amount_cents) AS amount_cents
                 FROM transactions WHERE user_id = ? AND type = 'expense'
                 GROUP BY category ORDER BY amount_cents DESC`,
                [userId]
            ),
        ]);

        const income = totals.find((r) => r.type === 'income');
        const expense = totals.find((r) => r.type === 'expense');
        const incomeCents = income ? income.total_cents : 0;
        const expenseCents = expense ? expense.total_cents : 0;

        res.json({
            summary: {
                incomeCents,
                expenseCents,
                balanceCents: incomeCents - expenseCents,
                transactionCount: totals.reduce((sum, r) => sum + r.count, 0),
                savingsRate: incomeCents > 0 ? (incomeCents - expenseCents) / incomeCents : null,
            },
            byCategory: categories.map((c) => ({ category: c.category, amountCents: c.amount_cents })),
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
