/**
 * Multinomial naive Bayes over merchant-string features.
 *
 * Written by hand rather than pulled from a library for two reasons: the whole
 * model is a few hundred integers, so it serialises into the repo and trains in
 * milliseconds at boot; and the interesting part of this problem is feature
 * extraction and honest evaluation, not the estimator.
 */

// Tokens that carry no category signal but appear across every bank export.
const STOPWORDS = new Set([
    'pos', 'debit', 'credit', 'purchase', 'authorized', 'on', 'recur', 'pmt',
    'payment', 'sq', 'tst', 'sp', 'ach', 'autopay', 'card', 'xxxxxx', 'llc', 'inc',
    'co', 'the', 'of', 'and',
]);

const US_STATES = new Set([
    'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id', 'il',
    'in', 'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms', 'mo', 'mt',
    'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri',
    'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy',
]);

/**
 * Strip the wrappers bank exports add, so the same merchant looks the same
 * however it was formatted.
 */
function normalize(description) {
    return String(description)
        .toLowerCase()
        .replace(/^\s*(?:sq|tst|sp|pos|ach|pmt|recur|autopay)\s*\*+\s*/i, ' ')  // processor prefixes
        .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, ' ')  // embedded dates
        .replace(/\bx{3,}\d*\b/g, ' ')                             // masked card numbers
        .replace(/#\s*\d+/g, ' ')                                  // store numbers
        .replace(/\b\d{4,}\b/g, ' ')                               // long digit runs
        .replace(/[^a-z0-9&* ]+/g, ' ')
        .replace(/\*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Word tokens plus character 5-grams.
 *
 * The character grams are what let the model handle a merchant it has never
 * seen: "PIZZERIA NAPOLI" shares grams with "PIZZA HUT" even though no word
 * token matches.
 *
 * The feature set was chosen by sweeping the cross-validation (see the PR for
 * the table). Words alone score 42.3% and memorise training merchants;
 * adding 3- and 4-grams *hurts* -- short grams like " co" and "ent" fire across
 * every category and drown the discriminative ones. 5-grams alone with word
 * tokens was the best of eleven configurations at 50.9%.
 */
function features(description) {
    const text = normalize(description);
    if (!text) return [];

    const tokens = [];

    for (const word of text.split(' ')) {
        if (!word || word.length < 2) continue;
        if (STOPWORDS.has(word)) continue;
        if (US_STATES.has(word)) continue;
        if (/^\d+$/.test(word)) continue;
        tokens.push(`w:${word}`);
    }

    const padded = ` ${text} `;
    const N = 5;
    for (let i = 0; i + N <= padded.length; i++) {
        const gram = padded.slice(i, i + N);
        if (gram.trim().length < N - 1) continue;
        tokens.push(`g:${gram}`);
    }

    return tokens;
}

class NaiveBayes {
    constructor({ alpha = 0.3 } = {}) {
        this.alpha = alpha;
        this.classCounts = new Map();
        this.tokenCounts = new Map();   // class -> Map(token -> count)
        this.classTotals = new Map();   // class -> total token count
        this.vocabulary = new Set();
        this.total = 0;
    }

    train(examples) {
        for (const { text, label } of examples) {
            this.classCounts.set(label, (this.classCounts.get(label) || 0) + 1);
            this.total++;

            if (!this.tokenCounts.has(label)) this.tokenCounts.set(label, new Map());
            const counts = this.tokenCounts.get(label);

            for (const token of features(text)) {
                counts.set(token, (counts.get(token) || 0) + 1);
                this.classTotals.set(label, (this.classTotals.get(label) || 0) + 1);
                this.vocabulary.add(token);
            }
        }
        return this;
    }

    /**
     * Returns { label, confidence, scores }. Confidence is the posterior of the
     * winning class, used by the caller to decide whether to trust the
     * prediction or fall back to the rule table.
     */
    predict(text, { allowedLabels = null } = {}) {
        const tokens = features(text);
        const vocabSize = this.vocabulary.size;
        const logScores = new Map();

        const labels = [...this.classCounts.keys()].filter(
            (l) => !allowedLabels || allowedLabels.includes(l)
        );

        if (labels.length === 0 || tokens.length === 0) {
            return { label: null, confidence: 0, scores: {} };
        }

        for (const label of labels) {
            const counts = this.tokenCounts.get(label);
            const denominator = (this.classTotals.get(label) || 0) + this.alpha * vocabSize;

            // Work in log space: these products underflow float64 quickly.
            let score = Math.log((this.classCounts.get(label) || 0) / this.total);
            for (const token of tokens) {
                score += Math.log(((counts.get(token) || 0) + this.alpha) / denominator);
            }
            logScores.set(label, score);
        }

        // Softmax over log scores, shifted by the max for numerical stability.
        const max = Math.max(...logScores.values());
        let sum = 0;
        const probabilities = new Map();
        for (const [label, score] of logScores) {
            const p = Math.exp(score - max);
            probabilities.set(label, p);
            sum += p;
        }

        let best = null;
        let bestP = -1;
        const scores = {};
        for (const [label, p] of probabilities) {
            const normalized = p / sum;
            scores[label] = normalized;
            if (normalized > bestP) {
                bestP = normalized;
                best = label;
            }
        }

        return { label: best, confidence: bestP, scores };
    }
}

module.exports = { NaiveBayes, features, normalize };
