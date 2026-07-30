const { NaiveBayes } = require('./naive-bayes');
const { labeledExamples, INCOME_CATEGORIES, EXPENSE_CATEGORIES } = require('./dataset');
const { guessCategory: ruleCategory } = require('../csv');

/**
 * Transaction categorisation: a rule table as the baseline, a naive Bayes
 * classifier layered on top, and a confidence threshold deciding which one
 * answers.
 *
 * The threshold is the honest part. The model is better than the rules on
 * average, but it is confidently wrong on merchants unlike anything it was
 * trained on, whereas the rules are either right or silent. Below the
 * threshold we defer to the rules; the eval in test/categorize.test.js reports
 * all three strategies so the combination has to earn its place.
 */

// Chosen a priori as "more likely than not, by a clear margin" rather than
// tuned. A sweep found 0.8 scores ~1 point higher, but that threshold was
// selected on the same folds the score is reported from, which would make the
// reported number optimistic. Not worth a point.
const CONFIDENCE_THRESHOLD = 0.6;

// Below this the model is guessing rather than predicting, and the abstention
// category is the more honest answer.
const FLOOR = 0.1;

const ABSTENTIONS = new Set(['Other', 'Other Income']);

let model = null;

function getModel() {
    if (!model) {
        model = new NaiveBayes().train(
            labeledExamples().map(({ merchant, category }) => ({ text: merchant, label: category }))
        );
    }
    return model;
}

/**
 * Predict a category for a transaction description.
 *
 * `type` constrains the label space: an expense can never be Salary, and no
 * amount of model confidence should be able to produce that.
 */
function categorize(description, type, { threshold = CONFIDENCE_THRESHOLD } = {}) {
    const allowedLabels = type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
    const fallback = ruleCategory(description, type);

    const { label, confidence, scores } = getModel().predict(description, { allowedLabels });

    if (label && confidence >= threshold) {
        return { category: label, source: 'model', confidence, scores };
    }

    // The rule table's "Other" is an abstention, not an opinion. Preferring it
    // over a low-confidence model guess throws away real signal in exchange for
    // a category that tells the user nothing -- so it only wins when it
    // actually matched a rule.
    if (!ABSTENTIONS.has(fallback)) {
        return { category: fallback, source: 'rules', confidence, scores };
    }

    if (label && confidence >= FLOOR) {
        return { category: label, source: 'model-low-confidence', confidence, scores };
    }

    return { category: fallback, source: 'abstain', confidence, scores };
}

/**
 * Fold user corrections into the model.
 *
 * A correction is worth more than a synthetic training row -- it is real
 * labeled data for a merchant this user actually transacts with -- so each one
 * is weighted up. Called at boot with whatever corrections have accumulated.
 */
function trainOnCorrections(corrections, { weight = 5 } = {}) {
    if (!corrections || corrections.length === 0) return getModel();

    const examples = [];
    for (const { description, category } of corrections) {
        for (let i = 0; i < weight; i++) {
            examples.push({ text: description, label: category });
        }
    }

    getModel().train(examples);
    return model;
}

/** Test seam: drop the trained model so the next call retrains from scratch. */
function resetModel() {
    model = null;
}

module.exports = {
    categorize,
    trainOnCorrections,
    resetModel,
    getModel,
    CONFIDENCE_THRESHOLD,
    FLOOR,
    ABSTENTIONS,
    INCOME_CATEGORIES,
    EXPENSE_CATEGORIES,
};
