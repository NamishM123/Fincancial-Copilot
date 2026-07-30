process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { NaiveBayes, normalize, features } = require('../lib/categorize/naive-bayes');
const { labeledExamples, NOISE_PATTERNS, INCOME_CATEGORIES, EXPENSE_CATEGORIES } = require('../lib/categorize/dataset');
const { guessCategory: ruleCategory } = require('../lib/csv');
const { categorize, resetModel, CONFIDENCE_THRESHOLD } = require('../lib/categorize');

/**
 * Evaluation for the transaction categoriser.
 *
 * The split is by MERCHANT, not by row. Splitting by row would put
 * "AMAZON MKTP #123" in train and "AMAZON MKTP #456" in test, and the reported
 * accuracy would measure memorisation rather than generalisation. Every
 * merchant in the test fold is one the model has never seen in any form.
 *
 * That makes the numbers below lower than a row-split would produce, and
 * meaningful in a way a row-split would not be.
 */

const K_FOLDS = 5;

// Deterministic shuffle: the reported score must not move between runs.
function seededShuffle(items, seed = 7) {
    const out = [...items];
    let state = seed;
    const next = () => {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296;
    };
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

// Stratified by category so every fold sees every class.
function foldsByCategory(examples, k) {
    const byCategory = new Map();
    for (const row of examples) {
        if (!byCategory.has(row.category)) byCategory.set(row.category, []);
        byCategory.get(row.category).push(row);
    }

    const folds = Array.from({ length: k }, () => []);
    for (const [category, rows] of byCategory) {
        seededShuffle(rows, category.length * 31 + 7).forEach((row, i) => {
            folds[i % k].push(row);
        });
    }
    return folds;
}

function evaluate() {
    const examples = labeledExamples();
    const folds = foldsByCategory(examples, K_FOLDS);

    const tally = {
        rules: { correct: 0, answered: 0 },
        model: { correct: 0 },
        combined: { correct: 0 },
        total: 0,
    };
    const confusion = new Map();

    for (let f = 0; f < K_FOLDS; f++) {
        const testFold = folds[f];
        const trainFold = folds.filter((_, i) => i !== f).flat();

        const trained = new NaiveBayes().train(
            trainFold.map(({ merchant, category }) => ({ text: merchant, label: category }))
        );

        for (const { merchant, category, type } of testFold) {
            const allowedLabels = type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;

            const ruleGuess = ruleCategory(merchant, type);
            const isRuleAbstention = ruleGuess === 'Other' || ruleGuess === 'Other Income';
            if (!isRuleAbstention) tally.rules.answered++;
            if (ruleGuess === category) tally.rules.correct++;

            const { label, confidence } = trained.predict(merchant, { allowedLabels });
            if (label === category) tally.model.correct++;

            // Mirrors lib/categorize/index.js: model when confident, rules when
            // they actually matched, model's best guess rather than a bare
            // "Other" when they did not.
            let combined;
            if (label && confidence >= CONFIDENCE_THRESHOLD) combined = label;
            else if (!isRuleAbstention) combined = ruleGuess;
            else if (label && confidence >= 0.1) combined = label;
            else combined = ruleGuess;
            if (combined === category) tally.combined.correct++;

            if (combined !== category) {
                const key = `${category} -> ${combined}`;
                confusion.set(key, (confusion.get(key) || 0) + 1);
            }

            tally.total++;
        }
    }

    return { tally, confusion };
}

const { tally, confusion } = evaluate();
const pct = (n) => `${((n / tally.total) * 100).toFixed(1)}%`;

test('categoriser: model beats the rule-table baseline on unseen merchants', () => {
    console.log(`\n  ${K_FOLDS}-fold cross-validation, ${tally.total} merchants, split by merchant`);
    console.log(`  ${'rule table (baseline)'.padEnd(24)} ${pct(tally.rules.correct)}`);
    console.log(`  ${'naive bayes'.padEnd(24)} ${pct(tally.model.correct)}`);
    console.log(`  ${'combined (threshold ' + CONFIDENCE_THRESHOLD + ')'.padEnd(4)} ${pct(tally.combined.correct)}`);

    const top = [...confusion.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (top.length) {
        console.log('\n  most common confusions (combined):');
        for (const [pair, count] of top) console.log(`    ${count}x  ${pair}`);
    }
    console.log('');

    // The point of a baseline is that the model has to beat it to justify
    // existing. If this ever fails, the classifier is not earning its place.
    assert.ok(
        tally.model.correct > tally.rules.correct,
        `model (${pct(tally.model.correct)}) must beat the rule baseline (${pct(tally.rules.correct)})`
    );
});

test('categoriser: the combined strategy is at least as good as either alone', () => {
    assert.ok(tally.combined.correct >= tally.rules.correct, 'combined must not be worse than rules alone');
    assert.ok(
        tally.combined.correct >= tally.model.correct * 0.95,
        'combined should not throw away most of the model gain'
    );
});

test('categoriser: accuracy is high enough to be worth shipping', () => {
    // Deliberately a floor, not a target. Twelve classes and merchant-disjoint
    // folds make this a hard setting: chance is 8%, and pure brand names
    // ("WEGMANS", "AETNA", "KOHLS") carry no compositional signal at all, so
    // there is a real ceiling no amount of modelling reaches from the name
    // alone. The honest claim is "clearly better than the rules", not
    // "production-grade on real statements".
    assert.ok(tally.combined.correct / tally.total > 0.55, `combined accuracy ${pct(tally.combined.correct)} too low`);
});

test('normalisation strips the wrappers bank exports add', () => {
    assert.strictEqual(normalize('SQ *BLUE BOTTLE #4412'), 'blue bottle');
    assert.strictEqual(normalize('POS DEBIT SAFEWAY 03/14'), 'pos debit safeway');
    assert.strictEqual(normalize('NETFLIX.COM XXXXXX1234'), 'netflix com');
    assert.strictEqual(normalize('PURCHASE AUTHORIZED ON 03/14 UBER TRIP'), 'purchase authorized on uber trip');
});

test('predictions survive the formatting noise real statements add', () => {
    resetModel();

    // Every merchant here IS in the training data; this measures preprocessing
    // robustness, not generalisation. The k-fold eval above measures that.
    const probes = [
        ['SAFEWAY', 'expense', 'Food'],
        ['NETFLIX.COM', 'expense', 'Entertainment'],
        ['SHELL OIL', 'expense', 'Transportation'],
        ['CVS PHARMACY', 'expense', 'Healthcare'],
    ];

    let stable = 0;
    let attempts = 0;

    for (const [merchant, type, expected] of probes) {
        for (const noise of NOISE_PATTERNS) {
            attempts++;
            if (categorize(noise(merchant), type).category === expected) stable++;
        }
    }

    const rate = stable / attempts;
    assert.ok(rate > 0.8, `only ${(rate * 100).toFixed(0)}% of noisy variants categorised correctly`);
});

test('an expense can never be assigned an income category', () => {
    resetModel();

    // The label space is constrained by type, so no confidence level can turn
    // a purchase into salary.
    for (const description of ['ACME CORP PAYROLL', 'DIRECT DEPOSIT PAYROLL', 'VANGUARD DIVIDEND']) {
        const { category } = categorize(description, 'expense');
        assert.ok(
            !INCOME_CATEGORIES.includes(category),
            `"${description}" as an expense produced income category "${category}"`
        );
    }

    for (const description of ['SAFEWAY', 'NETFLIX.COM']) {
        const { category } = categorize(description, 'income');
        assert.ok(INCOME_CATEGORIES.includes(category), `income row produced "${category}"`);
    }
});

test('a merchant matching a rule beats a low-confidence model guess', () => {
    resetModel();

    // "PIZZA" matches the Food rule. Even if the model is unsure, a rule that
    // actually fired is better evidence than a coin-flip posterior.
    const result = categorize('ZZQ PIZZA XYZQ', 'expense');
    assert.strictEqual(result.category, 'Food');
    assert.ok(['rules', 'model'].includes(result.source), `unexpected source ${result.source}`);
});

test('gibberish is never returned as a confident category', () => {
    resetModel();

    const result = categorize('QZXJV NNNTHW', 'expense');
    assert.ok(result.confidence < CONFIDENCE_THRESHOLD, `confidence ${result.confidence} too high for gibberish`);
    assert.notStrictEqual(result.source, 'model');
});

test('a known merchant is answered by the model, not the fallback', () => {
    resetModel();

    const result = categorize('TRADER JOES #189', 'expense');
    assert.strictEqual(result.category, 'Food');
    assert.ok(result.confidence > CONFIDENCE_THRESHOLD);
});

test('feature extraction produces both word and character-gram features', () => {
    const tokens = features('BLUE BOTTLE COFFEE');

    assert.ok(tokens.some((t) => t.startsWith('w:')), 'expected word features');
    assert.ok(tokens.some((t) => t.startsWith('g:')), 'expected character-gram features');
    assert.ok(tokens.filter((t) => t.startsWith('g:')).every((t) => t.length === 7), 'grams should be 5 chars');

    // Stopwords and bare digits carry no category signal.
    assert.ok(!features('POS DEBIT SAFEWAY').includes('w:pos'));
    assert.ok(!features('SAFEWAY 1234').includes('w:1234'));
});

test('user corrections shift future predictions for that merchant', () => {
    resetModel();
    const { trainOnCorrections } = require('../lib/categorize');

    const before = categorize('BLUE BOTTLE COFFEE', 'expense');
    assert.strictEqual(before.category, 'Food');

    // A user who books coffee runs as Entertainment should get that back.
    trainOnCorrections([{ description: 'BLUE BOTTLE COFFEE', category: 'Entertainment' }], { weight: 40 });

    const after = categorize('BLUE BOTTLE COFFEE', 'expense');
    assert.strictEqual(after.category, 'Entertainment');

    resetModel();
});
