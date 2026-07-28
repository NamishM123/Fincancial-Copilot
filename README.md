# Finance Copilot

A personal finance tracker with an assistant that answers questions by querying your
transactions rather than guessing at them.

Import a bank CSV, and it detects your recurring charges, breaks down where the money
goes, projects your balance forward, and lets you ask about any of it in plain English.

## What makes it different from a chatbot with a finance theme

The assistant does not receive your transactions as text in a prompt. It receives six
**functions** it can call — `get_summary`, `get_spending_by_category`,
`get_recurring_charges`, `get_monthly_totals`, `forecast_balance`, and
`search_transactions` — each of which runs against the full ledger in SQL and
`lib/analytics.js`.

The practical consequence: **every number in a reply is computed by this codebase.** The
model picks the query and phrases the answer. It is instructed never to state a figure it
did not get from a tool.

This also fixes a class of bug that context-stuffing produces. If you paste the 20 most
recent transactions into a prompt and ask "how much did I spend on food this year", you
get a confident answer derived from a partial view, with nothing to indicate anything was
missing. Tool calls see everything.

## Features

**Transactions**
- Manual entry, or CSV import from a bank or card statement
- Column names detected automatically across the spellings banks actually use
  (`Date` / `Transaction Date` / `Posting Date`, `Description` / `Merchant` / `Payee`,
  and either an `Amount` column or separate `Debit` / `Credit` columns)
- Handles quoted fields with embedded commas, escaped quotes, CRLF, the UTF-8 BOM Excel
  writes, negative and parenthesised-negative amounts, and several date formats
- Re-importing an overlapping statement is safe: rows are keyed by a content hash, so
  duplicates are skipped rather than double-entered
- Bad rows are reported individually with spreadsheet-aligned row numbers instead of
  failing the whole file

**Categorisation**
- Transactions are categorised automatically from the merchant description
- A naive Bayes classifier over word tokens and character 5-grams, layered on
  a rule table that acts as both baseline and fallback
- Measured by 5-fold cross-validation with **merchant-disjoint folds**: 40.2%
  (rules alone) to 59.3% (combined) across 12 categories on merchants the model
  has never seen. See "Categoriser accuracy" below for what that number does
  and does not claim
- Corrections are recorded and folded back into the model at startup, weighted
  above the built-in corpus because they are real labels for merchants the user
  actually transacts with

**Analytics**
- Spending by category, income vs expenses by month, savings rate
- **Recurring charge detection** — groups by a normalised merchant key so
  `SQ *BLUE BOTTLE #4412` and `#9981` collapse to one merchant, then requires at least
  three occurrences, a median interval matching a known cadence, and a stable amount.
  Reports cadence, monthly equivalent, and price increases
- Balance forecasting from detected recurring charges plus a daily discretionary rate

**Assistant**
- Tool calling over the analytics above
- Works without an API key: falls back to answering from the same analytics, clearly
  labelled, so the figures stay real even when the model is unavailable

**Accounts**
- Registration and login with bcrypt-hashed passwords and JWT sessions
- One-click demo account seeded with a year of generated sample data

## Running it

Requires Node 18 or newer.

```bash
git clone https://github.com/NamishM123/Fincancial-Copilot.git
cd Fincancial-Copilot/backend
npm install

cp .env.example .env
npm run gen-secret          # paste the output into .env as JWT_SECRET

npm start
```

Then open <http://localhost:3000>. The server serves the frontend as well as the API, so
there is nothing else to start.

Click **Try the demo** to get a populated dashboard immediately, or register an account
and import a CSV.

### Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `JWT_SECRET` | **yes** | — | Signs session tokens. Must be ≥32 characters. The server refuses to start without it. |
| `JWT_EXPIRES_IN` | no | `24h` | Session lifetime. |
| `PORT` | no | `3000` | |
| `DATABASE_FILE` | no | `finance.db` | SQLite file, relative to `backend/`. |
| `OPENAI_API_KEY` | no | — | Without it the assistant answers from the built-in analytics. |
| `OPENAI_MODEL` | no | `gpt-4o-mini` | |
| `OPENAI_MAX_TOKENS` | no | `500` | |
| `CORS_ORIGINS` | no | — | Comma-separated. Only needed if the frontend is hosted separately. |

## Tests

```bash
cd backend
npm test
```

103 tests via `node:test` and `supertest`, running against in-memory SQLite.

Coverage worth calling out:

- **Cross-user isolation** — user B gets a 404 on user A's transaction, and the row is
  verified still present afterwards
- **Forged tokens** — a JWT signed with a different secret is rejected
- **Cent-exact arithmetic** — ten `0.10` expenses sum to exactly `100` cents
- **Recurring detection negatives** — an irregularly visited merchant, a merchant whose
  amount swings, a two-occurrence series, and recurring income all correctly fail to
  qualify. A detector that fires on everything is worse than none
- **CSV edge cases** — quoted commas, BOM, `2026-02-31` rejected rather than rolled into
  March, re-import as a no-op

### Assistant evals

`test/chat-evals.test.js` scores the assistant against a fixed ledger fixture with
hand-computed totals:

```
eval score: 12/12
```

Twelve questions, each paired with a known-correct answer, chosen so there is a plausible
wrong answer available to get wrong. "How much did I spend in January?" must return
`176514` cents, not the all-time `507812`. A query for a month with no data must return
zero rather than the all-time total.

The point is to make assistant quality a number that moves rather than a feeling.

## Project structure

```
backend/
├── app.js                    Express app (exported for tests)
├── server.js                 boot and graceful shutdown
├── config.js                 env parsing with fail-fast validation
├── db.js                     schema and promisified sqlite3
├── middleware/auth.js        JWT verification
├── routes/
│   ├── auth.js               register, login, me
│   ├── transactions.js       CRUD, CSV import, summary, recurring, forecast
│   ├── chat.js               tool definitions and the tool-calling loop
│   └── demo.js               seeded sandbox accounts
├── lib/
│   ├── analytics.js          summaries, recurring detection, forecasting
│   ├── csv.js                parser, column detection, date parsing
│   ├── money.js              dollar/cent conversion
│   ├── dedupe.js             content hashing for duplicate detection
│   └── seed.js               demo data generator
└── test/

frontend/
├── index.html                single-page app
└── vendor/chart.umd.min.js   vendored rather than CDN-loaded
```

## API

All endpoints except the first four require an `Authorization: Bearer <token>` header.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Status, and whether an AI key is configured |
| `POST` | `/api/register` | Create an account |
| `POST` | `/api/login` | Obtain a token |
| `POST` | `/api/demo` | Provision a seeded demo account |
| `GET` | `/api/me` | Current user |
| `GET` | `/api/transactions` | List, paginated (`limit`, `offset`) |
| `POST` | `/api/transactions` | Create |
| `DELETE` | `/api/transactions/:id` | Delete |
| `POST` | `/api/transactions/import` | Import CSV text |
| `PATCH` | `/api/transactions/:id/category` | Correct a category, recorded as training data |
| `GET` | `/api/transactions/categorization-stats` | Observed correction rate for this user |
| `GET` | `/api/transactions/summary` | Totals, categories, monthly series |
| `GET` | `/api/transactions/recurring` | Detected subscriptions |
| `GET` | `/api/transactions/forecast` | Balance projection (`days`) |
| `POST` | `/api/chat` | Ask the assistant |

**All monetary values in the API are integer cents.** Money is never stored or transmitted
as a float: binary floating point cannot represent `0.10` exactly, so summing float
amounts accumulates drift and produces balances that do not reconcile.

## Implementation notes

**Rate limits.** 20 auth attempts per IP per 15 minutes, 10 chat messages per user per
minute, 30 demo accounts per IP per hour. `/api/chat` costs money per call, so it needs a
ceiling that is per-user rather than per-IP.

**Login does not leak account existence.** The same error and comparable work happen
whether or not the email is registered.

### Categoriser accuracy

The reported 59.3% comes from 5-fold cross-validation where **folds are split by
merchant, not by row**. A row split would put `AMAZON MKTP #123` in training and
`AMAZON MKTP #456` in test, and the resulting number would measure memorisation. Every
merchant in a test fold is one the model has never seen in any form.

| Strategy | Accuracy |
|---|---|
| Rule table (baseline) | 40.2% |
| Naive Bayes alone | 50.9% |
| Combined, confidence threshold 0.6 | **59.3%** |

Three caveats, stated so the number is not over-read:

1. **The training corpus is hand-authored merchant names, not real bank data.** This
   measures generalisation across merchant *names*; it does not predict performance on
   any particular person's statement. `GET /api/transactions/categorization-stats`
   reports the observed correction rate per user, which is the number that actually
   matters. Replacing the corpus with real labeled data is the highest-value improvement
   available here.
2. **There is a ceiling.** Pure brand names — `WEGMANS`, `AETNA`, `KOHLS` — carry no
   compositional signal, so no model reaches them from the name alone. Names containing a
   category word (`PIZZERIA NAPOLI`, `CITY WATER DEPT`) generalise; arbitrary brands do
   not.
3. **The confidence threshold was chosen a priori, not tuned.** A sweep found 0.8 scores
   about a point higher, but selecting it on the same folds the score is reported from
   would make the number optimistic. It was not adopted.

Feature choice was decided by sweeping eleven configurations. Words alone score 42.3%;
adding 3- and 4-grams *hurts*, because short grams fire across every category and drown
the discriminative ones. Words plus 5-grams was the best.

## Deployment

The server serves both the API and the frontend, so it deploys as a single Node service.
Set `JWT_SECRET` and it will boot.

One caveat worth knowing before you deploy: **SQLite on an ephemeral filesystem loses data
on every restart.** Most platform free tiers have ephemeral disks. For anything with real
users, either attach a persistent volume or move to Postgres. The demo works fine either
way, since demo accounts are provisioned on demand.

## Not implemented

Stated plainly so the feature list above can be trusted:

- No bank account linking. CSV import is the only bulk path in.
- The categoriser is trained on hand-authored merchant names, not real statements.
- No budget goals or alerts.
- Transactions can be created, recategorised, and deleted, but not otherwise edited.
- No multi-currency support. Amounts are treated as a single currency.
- No password reset, email verification, or token refresh.
- No receipt photo parsing.

## License

MIT.
