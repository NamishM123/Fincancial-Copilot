process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const chat = require('../routes/chat');
const { LEDGER, EXPECTED } = require('./fixtures/ledger');

const { TOOLS, runToolLoop, deterministicReply } = chat;

const call = (name, args = {}) => TOOLS[name].run(LEDGER, args);

/**
 * Eval set: questions a user would actually ask, each paired with an answer
 * computed by hand from test/fixtures/ledger.js.
 *
 * The point is to make "the assistant is good" a number that moves rather than
 * a feeling. The tool layer is what these check, because that is where the
 * figures come from -- the model only phrases them.
 */
const EVALS = [
    {
        question: 'What is my overall balance?',
        tool: 'get_summary',
        args: {},
        expect: (r) => r.balanceCents === EXPECTED.balanceCents,
        describe: `balanceCents === ${EXPECTED.balanceCents}`,
    },
    {
        question: 'How much did I earn in total?',
        tool: 'get_summary',
        args: {},
        expect: (r) => r.incomeCents === EXPECTED.totalIncomeCents,
        describe: `incomeCents === ${EXPECTED.totalIncomeCents}`,
    },
    {
        question: 'How much did I spend in January?',
        tool: 'get_summary',
        args: { start_date: '2026-01-01', end_date: '2026-01-31' },
        expect: (r) => r.expenseCents === EXPECTED.january.expenseCents,
        describe: `January expenseCents === ${EXPECTED.january.expenseCents}`,
    },
    {
        question: 'What did I spend on food across all my history?',
        tool: 'get_spending_by_category',
        args: {},
        expect: (r) => r.find((c) => c.category === 'Food').amountCents === EXPECTED.allFoodCents,
        describe: `Food total === ${EXPECTED.allFoodCents}`,
    },
    {
        question: 'What did I spend on food in February?',
        tool: 'get_spending_by_category',
        args: { start_date: '2026-02-01', end_date: '2026-02-28' },
        expect: (r) => r.find((c) => c.category === 'Food').amountCents === EXPECTED.februaryFoodCents,
        describe: `February Food === ${EXPECTED.februaryFoodCents}`,
    },
    {
        question: 'What is my biggest expense category?',
        tool: 'get_spending_by_category',
        args: {},
        expect: (r) => r[0].category === 'Utilities' && r[0].amountCents === EXPECTED.allRentCents,
        describe: 'largest category is Utilities at 450000',
    },
    {
        question: 'What subscriptions am I paying for?',
        tool: 'get_recurring_charges',
        args: {},
        expect: (r) => {
            const keys = r.map((x) => x.merchantKey).sort();
            return JSON.stringify(keys) === JSON.stringify([...EXPECTED.recurringMerchants].sort());
        },
        describe: `recurring merchants are ${EXPECTED.recurringMerchants.join(', ')}`,
    },
    {
        question: 'Did any of my subscriptions go up in price?',
        tool: 'get_recurring_charges',
        args: {},
        expect: (r) => {
            const netflix = r.find((x) => x.merchantKey === 'netflix com');
            return netflix.amountChanged
                && netflix.amountChanged.fromCents === EXPECTED.netflixPriceRise.fromCents
                && netflix.amountChanged.toCents === EXPECTED.netflixPriceRise.toCents;
        },
        describe: 'Netflix rose from 1599 to 1799',
    },
    {
        question: 'How many times did I shop at Safeway?',
        tool: 'search_transactions',
        args: { query: 'safeway' },
        expect: (r) => r.length === EXPECTED.safewayVisits,
        describe: `${EXPECTED.safewayVisits} Safeway transactions`,
    },
    {
        question: 'Show me my income transactions',
        tool: 'search_transactions',
        args: { type: 'income' },
        expect: (r) => r.length === 4 && r.every((t) => t.type === 'income'),
        describe: '4 income rows',
    },
    {
        question: 'How did my spending change month over month?',
        tool: 'get_monthly_totals',
        args: {},
        expect: (r) => r.length === 3
            && r[0].month === '2026-01'
            && r[0].expenseCents === EXPECTED.january.expenseCents
            && r[0].netCents === EXPECTED.january.netCents,
        describe: 'three months, oldest first, January net 223486',
    },
    {
        question: 'What did I spend in a month I have no data for?',
        tool: 'get_summary',
        args: { start_date: '2025-06-01', end_date: '2025-06-30' },
        expect: (r) => r.transactionCount === 0 && r.expenseCents === 0,
        describe: 'empty range returns zeroes, not the all-time total',
    },
];

test('assistant eval set: every question resolves to its ground-truth answer', () => {
    const failures = [];

    for (const evalCase of EVALS) {
        let passed = false;
        let detail = '';

        try {
            passed = evalCase.expect(call(evalCase.tool, evalCase.args));
        } catch (err) {
            detail = ` (threw: ${err.message})`;
        }

        if (!passed) {
            failures.push(`  "${evalCase.question}"\n    via ${evalCase.tool} — expected ${evalCase.describe}${detail}`);
        }
    }

    const score = EVALS.length - failures.length;
    console.log(`\n  eval score: ${score}/${EVALS.length}`);

    assert.strictEqual(
        failures.length,
        0,
        `${failures.length}/${EVALS.length} evals failed:\n${failures.join('\n')}`
    );
});

test('date-range tools do not leak data from outside the range', () => {
    // The regression this guards: the previous implementation passed the 20
    // most recent transactions to the model regardless of what was asked, so a
    // question about January was answered from whatever happened to be in the
    // window.
    const january = call('get_summary', { start_date: '2026-01-01', end_date: '2026-01-31' });

    assert.strictEqual(january.expenseCents, EXPECTED.january.expenseCents);
    assert.notStrictEqual(january.expenseCents, EXPECTED.totalExpenseCents);
    assert.strictEqual(january.incomeCents, EXPECTED.january.incomeCents);
});

test('every tool is reachable, schema-valid, and returns JSON-serialisable data', () => {
    for (const [name, tool] of Object.entries(TOOLS)) {
        assert.strictEqual(tool.schema.function.name, name, `${name}: schema name must match its key`);
        assert.strictEqual(tool.schema.type, 'function');
        assert.strictEqual(tool.schema.function.parameters.type, 'object');
        assert.ok(tool.schema.function.description.length > 20, `${name}: needs a usable description`);

        const result = tool.run(LEDGER, {});
        assert.doesNotThrow(() => JSON.stringify(result), `${name}: result must serialise`);
    }
});

test('tools handle an empty ledger without throwing', () => {
    for (const [name, tool] of Object.entries(TOOLS)) {
        assert.doesNotThrow(() => tool.run([], {}), `${name} threw on an empty ledger`);
    }
});

test('search_transactions caps its result count', () => {
    assert.strictEqual(call('search_transactions', { limit: 3 }).length, 3);
    assert.ok(call('search_transactions', { limit: 9999 }).length <= 100);
});

// --- tool loop mechanics, driven by a stub client ---

function stubClient(script) {
    let round = 0;
    const seen = [];

    return {
        calls: seen,
        chat: {
            completions: {
                create: async (params) => {
                    seen.push(params);
                    const response = script[Math.min(round, script.length - 1)];
                    round++;
                    return { choices: [{ message: response }] };
                },
            },
        },
    };
}

const toolCall = (id, name, args) => ({
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
});

test('tool loop feeds results back and returns the final answer', async () => {
    const client = stubClient([
        { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'get_summary', {})] },
        { role: 'assistant', content: 'Your balance is $7,671.88.' },
    ]);

    const { reply, toolsUsed } = await runToolLoop(client, LEDGER, 'What is my balance?');

    assert.strictEqual(reply, 'Your balance is $7,671.88.');
    assert.deepStrictEqual(toolsUsed, ['get_summary']);

    // The second request must carry the assistant turn plus a matching tool
    // result, or the provider rejects it.
    const secondRequest = client.calls[1];
    const toolMessage = secondRequest.messages.find((m) => m.role === 'tool');

    assert.ok(toolMessage, 'expected a tool result message');
    assert.strictEqual(toolMessage.tool_call_id, 'c1');
    assert.strictEqual(JSON.parse(toolMessage.content).balanceCents, EXPECTED.balanceCents);
});

test('tool loop handles several tool calls in one turn', async () => {
    const client = stubClient([
        {
            role: 'assistant',
            content: null,
            tool_calls: [
                toolCall('c1', 'get_summary', {}),
                toolCall('c2', 'get_recurring_charges', {}),
            ],
        },
        { role: 'assistant', content: 'Done.' },
    ]);

    const { toolsUsed } = await runToolLoop(client, LEDGER, 'Summarise everything');

    assert.deepStrictEqual(toolsUsed, ['get_summary', 'get_recurring_charges']);
    assert.strictEqual(client.calls[1].messages.filter((m) => m.role === 'tool').length, 2);
});

test('tool loop reports an unknown tool back to the model instead of crashing', async () => {
    const client = stubClient([
        { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'no_such_tool', {})] },
        { role: 'assistant', content: 'I could not do that.' },
    ]);

    const { reply, toolsUsed } = await runToolLoop(client, LEDGER, 'Do something impossible');

    assert.strictEqual(reply, 'I could not do that.');
    assert.deepStrictEqual(toolsUsed, []);
    assert.match(client.calls[1].messages.find((m) => m.role === 'tool').content, /Unknown tool/);
});

test('tool loop stops after a bounded number of rounds', async () => {
    // A model that only ever calls tools must not loop forever spending money.
    const client = stubClient([
        { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'get_summary', {})] },
    ]);

    const { reply } = await runToolLoop(client, LEDGER, 'Loop forever');

    assert.ok(client.calls.length <= 4, `expected at most 4 requests, got ${client.calls.length}`);
    assert.match(reply, /different way/);
});

test('every tool is advertised to the model on each request', async () => {
    const client = stubClient([{ role: 'assistant', content: 'Hello.' }]);
    await runToolLoop(client, LEDGER, 'Hi');

    const names = client.calls[0].tools.map((t) => t.function.name).sort();
    assert.deepStrictEqual(names, Object.keys(TOOLS).sort());
});

test('deterministic fallback quotes real figures from the ledger', () => {
    const subs = deterministicReply(LEDGER, 'what subscriptions do I have?');
    assert.match(subs, /NETFLIX/i);

    const categories = deterministicReply(LEDGER, 'where does my money go?');
    assert.match(categories, /Utilities/);
    assert.match(categories, /4500\.00/); // 450000 cents of rent

    assert.match(deterministicReply([], 'anything'), /no transactions/i);
});
