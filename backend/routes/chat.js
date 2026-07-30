const express = require('express');
const rateLimit = require('express-rate-limit');
const OpenAI = require('openai');
const db = require('../db');
const config = require('../config');
const { authenticateToken } = require('../middleware/auth');
const { formatCents } = require('../lib/money');
const analytics = require('../lib/analytics');

const router = express.Router();
router.use(authenticateToken);

// An authenticated endpoint that spends money per call needs its own ceiling.
const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: config.isTest ? 100000 : 10,
    keyGenerator: (req) => String(req.user.userId),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'You are sending messages too quickly. Give it a moment.' },
});

const openai = config.openai.apiKey ? new OpenAI({ apiKey: config.openai.apiKey }) : null;

const loadAll = (userId) =>
    db.all('SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC, id DESC', [userId]);

const inRange = (rows, start, end) =>
    rows.filter((t) => (!start || t.date >= start) && (!end || t.date <= end));

/**
 * The model gets these instead of a dump of raw transactions. Two reasons:
 * the old approach truncated at 20 rows, so any question spanning more history
 * was answered confidently and wrongly; and every number in a reply now comes
 * from SQL and this module rather than from the model's arithmetic.
 */
const TOOLS = {
    get_summary: {
        schema: {
            type: 'function',
            function: {
                name: 'get_summary',
                description: 'Total income, total expenses, net balance, savings rate, and transaction count over an optional date range.',
                parameters: {
                    type: 'object',
                    properties: {
                        start_date: { type: 'string', description: 'Inclusive start date, YYYY-MM-DD' },
                        end_date: { type: 'string', description: 'Inclusive end date, YYYY-MM-DD' },
                    },
                },
            },
        },
        run: (rows, args) => analytics.summarize(inRange(rows, args.start_date, args.end_date)),
    },

    get_spending_by_category: {
        schema: {
            type: 'function',
            function: {
                name: 'get_spending_by_category',
                description: 'Spending totals grouped by category, largest first, over an optional date range.',
                parameters: {
                    type: 'object',
                    properties: {
                        start_date: { type: 'string', description: 'Inclusive start date, YYYY-MM-DD' },
                        end_date: { type: 'string', description: 'Inclusive end date, YYYY-MM-DD' },
                        type: { type: 'string', enum: ['income', 'expense'] },
                    },
                },
            },
        },
        run: (rows, args) => analytics.byCategory(inRange(rows, args.start_date, args.end_date), args.type || 'expense'),
    },

    get_recurring_charges: {
        schema: {
            type: 'function',
            function: {
                name: 'get_recurring_charges',
                description: 'Detected subscriptions and recurring bills, with cadence, typical amount, monthly equivalent, and any price change.',
                parameters: { type: 'object', properties: {} },
            },
        },
        run: (rows) => analytics.detectRecurring(rows),
    },

    forecast_balance: {
        schema: {
            type: 'function',
            function: {
                name: 'forecast_balance',
                description: 'Project the balance forward using detected recurring charges plus a daily rate for discretionary spending.',
                parameters: {
                    type: 'object',
                    properties: { days: { type: 'integer', description: 'How many days ahead to project (1-365)' } },
                },
            },
        },
        run: (rows, args) => analytics.forecast(rows, { days: Math.min(Math.max(args.days || 30, 1), 365) }),
    },

    get_monthly_totals: {
        schema: {
            type: 'function',
            function: {
                name: 'get_monthly_totals',
                description: 'Income, expenses, and net per calendar month, oldest first. Use for trend and month-over-month questions.',
                parameters: { type: 'object', properties: {} },
            },
        },
        run: (rows) => analytics.monthlySeries(rows),
    },

    search_transactions: {
        schema: {
            type: 'function',
            function: {
                name: 'search_transactions',
                description: 'Find individual transactions by description text, category, type, or date range.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Case-insensitive substring of the description' },
                        category: { type: 'string' },
                        type: { type: 'string', enum: ['income', 'expense'] },
                        start_date: { type: 'string' },
                        end_date: { type: 'string' },
                        limit: { type: 'integer', description: 'Max rows to return, default 25' },
                    },
                },
            },
        },
        run: (rows, args) => {
            const q = (args.query || '').toLowerCase();
            return inRange(rows, args.start_date, args.end_date)
                .filter((t) => (!q || t.description.toLowerCase().includes(q))
                    && (!args.category || t.category === args.category)
                    && (!args.type || t.type === args.type))
                .slice(0, Math.min(args.limit || 25, 100))
                .map((t) => ({ date: t.date, description: t.description, amountCents: t.amount_cents, type: t.type, category: t.category }));
        },
    },
};

const SYSTEM_PROMPT = `You are Finance Copilot, a personal finance assistant.

Rules:
- Never state a number the user did not give you and you did not get from a tool. Call a tool instead of estimating.
- All monetary values from tools are integer CENTS. Divide by 100 and format as dollars in your reply.
- If the tools return no data, say the user has no transactions in that range rather than inventing an example.
- Be concise: two or three short paragraphs at most, and lead with the direct answer.
- Give practical suggestions grounded in the user's actual figures, not generic advice.
- Today's date is ${'${TODAY}'}.`;

/**
 * Takes the client as a parameter rather than closing over the module-level one
 * so tests can drive the loop with a stub and assert on the exchange.
 */
async function runToolLoop(client, rows, userMessage) {
    const messages = [
        { role: 'system', content: SYSTEM_PROMPT.replace('${TODAY}', new Date().toISOString().slice(0, 10)) },
        { role: 'user', content: userMessage },
    ];
    const toolSchemas = Object.values(TOOLS).map((t) => t.schema);
    const toolsUsed = [];

    // Bounded so a model that keeps calling tools can't loop up the bill.
    for (let round = 0; round < 4; round++) {
        const completion = await client.chat.completions.create({
            model: config.openai.model,
            messages,
            tools: toolSchemas,
            max_tokens: config.openai.maxOutputTokens,
            temperature: 0.3,
        });

        const choice = completion.choices[0].message;

        if (!choice.tool_calls || choice.tool_calls.length === 0) {
            return { reply: choice.content, toolsUsed };
        }

        messages.push(choice);

        for (const call of choice.tool_calls) {
            const tool = TOOLS[call.function.name];
            let result;

            try {
                const args = JSON.parse(call.function.arguments || '{}');
                result = tool ? tool.run(rows, args) : { error: `Unknown tool ${call.function.name}` };
                if (tool) toolsUsed.push(call.function.name);
            } catch (err) {
                result = { error: `Tool failed: ${err.message}` };
            }

            messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify(result),
            });
        }
    }

    return { reply: "I wasn't able to work that one out — try asking it a different way.", toolsUsed };
}

/**
 * Used when no OpenAI key is configured. It answers from the same analytics the
 * tools use, so the numbers are real; it just can't handle open-ended phrasing.
 */
function deterministicReply(rows, message) {
    if (rows.length === 0) {
        return 'You have no transactions yet. Add a few or import a CSV, and I can break down your spending.';
    }

    const msg = message.toLowerCase();
    const summary = analytics.summarize(rows);

    if (/subscription|recurring|repeat/.test(msg)) {
        const recurring = analytics.detectRecurring(rows);
        if (recurring.length === 0) return 'I could not detect any recurring charges in your history yet.';
        const monthly = recurring.reduce((s, r) => s + r.monthlyEquivalentCents, 0);
        const lines = recurring.slice(0, 8).map((r) => `- ${r.merchant}: ${formatCents(r.typicalCents)} ${r.cadence}`);
        return `You have ${recurring.length} recurring charges totalling about ${formatCents(monthly)}/month:\n${lines.join('\n')}`;
    }

    if (/forecast|project|run out|afford/.test(msg)) {
        const f = analytics.forecast(rows, { days: 30 });
        return `Projected balance in 30 days: ${formatCents(f.projectedBalanceCents)} (from ${formatCents(f.startingBalanceCents)} today). Expected inflow ${formatCents(f.expectedInflowCents)}, recurring outflow ${formatCents(f.recurringOutflowCents)}, discretionary ${formatCents(f.discretionaryOutflowCents)}.`;
    }

    if (/categor|spend|budget|where/.test(msg)) {
        const cats = analytics.byCategory(rows, 'expense').slice(0, 5);
        const lines = cats.map((c) => `- ${c.category}: ${formatCents(c.amountCents)}`);
        return `Your largest expense categories:\n${lines.join('\n')}\n\nTotal spending: ${formatCents(summary.expenseCents)}.`;
    }

    const rate = summary.savingsRate === null ? 'n/a' : `${(summary.savingsRate * 100).toFixed(1)}%`;
    return `Across ${summary.transactionCount} transactions: income ${formatCents(summary.incomeCents)}, expenses ${formatCents(summary.expenseCents)}, net ${formatCents(summary.balanceCents)} (savings rate ${rate}). Ask about categories, subscriptions, or a forecast for more detail.`;
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
        const rows = await loadAll(req.user.userId);

        if (!openai) {
            return res.json({
                message: deterministicReply(rows, message),
                mode: 'deterministic',
                notice: 'OPENAI_API_KEY is not set, so this reply came from the built-in analytics rather than a language model.',
            });
        }

        const { reply, toolsUsed } = await runToolLoop(openai, rows, message.trim());
        res.json({ message: reply, mode: 'llm', toolsUsed });
    } catch (err) {
        // A provider outage shouldn't take the feature down entirely.
        if (err.status || err.name === 'APIError' || /openai/i.test(err.message || '')) {
            try {
                const rows = await loadAll(req.user.userId);
                return res.json({
                    message: deterministicReply(rows, message),
                    mode: 'deterministic',
                    notice: 'The AI service is unavailable right now, so this reply came from the built-in analytics.',
                });
            } catch (inner) {
                return next(inner);
            }
        }
        next(err);
    }
});

module.exports = router;
module.exports.TOOLS = TOOLS;
module.exports.runToolLoop = runToolLoop;
module.exports.deterministicReply = deterministicReply;
module.exports.SYSTEM_PROMPT = SYSTEM_PROMPT;
