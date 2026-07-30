const path = require('path');
const express = require('express');
const cors = require('cors');
const config = require('./config');

const app = express();

// The frontend is served from this same process, so the common case is
// same-origin and needs no CORS at all. CORS_ORIGINS exists for setups that
// host the static files elsewhere.
if (config.corsOrigins.length > 0) {
    app.use(cors({ origin: config.corsOrigins, credentials: true }));
}

app.use(express.json({ limit: '4mb' }));

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        aiConfigured: Boolean(config.openai.apiKey),
    });
});

app.use('/api', require('./routes/auth'));
app.use('/api/transactions', require('./routes/transactions'));
app.use('/api/chat', require('./routes/chat'));

// Serving the SPA from the API removes the cross-origin setup entirely and
// makes this a single deployable unit.
const frontendDir = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendDir));

app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(frontendDir, 'index.html'));
});

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    // Never leak internal messages to the client.
    res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
