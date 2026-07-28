const jwt = require('jsonwebtoken');
const config = require('../config');

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, config.jwtSecret, (err, payload) => {
        if (err) {
            return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
        }
        req.user = payload;
        next();
    });
}

function signToken(user) {
    return jwt.sign(
        { userId: user.id, username: user.username },
        config.jwtSecret,
        { expiresIn: config.jwtExpiresIn }
    );
}

module.exports = { authenticateToken, signToken };
