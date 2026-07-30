const express = require('express');
const rateLimit = require('express-rate-limit');
const OpenAI = require('openai');
const db = require('../db');
const config = require('../config');
const { authenticateToken } = require('../middleware/auth');
const { formatCents } = require('../lib/money');

const router = express.Router();
router.use(authenticateToken);

// An authenticated endpoint that spends money per call needs its own ceiling,
// keyed by user rather than IP so one account can't burn the whole budget.
const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: config.isTest ? 100000 : 10,
    keyGenerator: (req) => String(req.user.userId),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'You are sending messages too quickly. Give it a moment.' },
});

const openai = config.openai.apiKey ? new OpenAI({ apiKey: config.openai.apiKey }) : null;

// NOTE: this still stuffs recent transactions into the prompt, which means the
// model answers questions about longer ranges from a partial view. Replacing
// this with tool calls over the analytics engine is the next PR in the stack.
const CONTEXT_ROWS = 50;

function buildContext(rows) {
    if (rows.length === 0) return 'The user has no transactions recorded yet.';

    const lines = rows.map(
        (t) => `${t.date} | ${t.type} | ${t.category} | ${t.description} | ${formatCents(t.amount_cents)}`
    );

    return `The user's ${rows.length} most recent transactions (date | type | category | description | amount):\n${lines.join('\n')}`;
}

function fallbackReply(rows) {
    if (rows.length === 0) {
        return 'You have no transactions yet. Add a few and I can break down your spending.';
    }

    let income = 0;
    let expense = 0;
    for (const t of rows) {
        if (t.type === 'income') income += t.amount_cents;
        else expense += t.amount_cents;
    }

    return `Across your ${rows.length} most recent transactions: income ${formatCents(income)}, expenses ${formatCents(expense)}, net ${formatCents(income - expense)}.`;
}

router.post('/', chatLimiter, async (req, res, next) => {
    const message = (req.body && req.body.message) || '';

    if (typeof message !== 'string' || message.trim() === '') {
        return res.status(400).json({ error: 'Message is required' });
    }
    if (message.length > config.limits.chatMessageChars) {
        return res.status(400).json({ error: `Message is too long (limit ${config.limits.chatMessageChars} characters)` });
    }

    try {
        const rows = await db.all(
            'SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT ?',
            [req.user.userId, CONTEXT_ROWS]
        );

        if (!openai) {
            return res.json({
                message: fallbackReply(rows),
                mode: 'deterministic',
                notice: 'OPENAI_API_KEY is not set, so this reply was computed locally rather than by a language model.',
            });
        }

        const completion = await openai.chat.completions.create({
            model: config.openai.model,
            max_tokens: config.openai.maxOutputTokens,
            temperature: 0.3,
            messages: [
                {
                    role: 'system',
                    content:
                        'You are Finance Copilot, a personal finance assistant. Answer using only the ' +
                        'transaction data provided below. If the data does not cover what was asked, say so ' +
                        'rather than guessing. Be concise and lead with the direct answer.\n\n' +
                        `Today's date is ${new Date().toISOString().slice(0, 10)}.\n\n` +
                        buildContext(rows),
                },
                { role: 'user', content: message.trim() },
            ],
        });

        res.json({ message: completion.choices[0].message.content, mode: 'llm' });
    } catch (err) {
        // A provider outage shouldn't take the whole feature down.
        if (err.status || err.name === 'APIError' || /openai/i.test(err.message || '')) {
            try {
                const rows = await db.all(
                    'SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT ?',
                    [req.user.userId, CONTEXT_ROWS]
                );
                return res.json({
                    message: fallbackReply(rows),
                    mode: 'deterministic',
                    notice: 'The AI service is unavailable right now, so this reply was computed locally.',
                });
            } catch (inner) {
                return next(inner);
            }
        }
        next(err);
    }
});

module.exports = router;
