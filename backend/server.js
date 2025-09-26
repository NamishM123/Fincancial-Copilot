const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const OpenAI = require('openai');
require('dotenv').config();

const app = express();
const PORT = 3000;

// Middleware
app.use(cors({
    origin: ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:8080', 'http://127.0.0.1:8080'],
    credentials: true
}));
app.use(express.json());

// Initialize SQLite Database
const db = new sqlite3.Database('finance.db');

// Create tables
db.serialize(() => {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Transactions table
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        description TEXT NOT NULL,
        amount REAL NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
        category TEXT NOT NULL,
        date TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
    )`);
});

// Initialize OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || 'your-api-key-here'
});

console.log('🚀 Finance Copilot Backend Starting...');
console.log('💾 Database initialized');
console.log('🤖 AI system ready');
console.log(`🔗 CORS enabled for frontend connections`);

// Test endpoint
app.get('/', (req, res) => {
    res.json({ 
        message: '💰 Finance Copilot Backend is running!',
        status: 'success',
        features: ['Database', 'Authentication', 'AI Integration'],
        endpoints: [
            'POST /api/register',
            'POST /api/login', 
            'GET /api/transactions',
            'POST /api/transactions',
            'GET /api/summary',
            'POST /api/chat'
        ]
    });
});

// Authentication middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }
    
    jwt.verify(token, 'your-secret-key', (err, user) => {
        if (err) {
            console.log('Token verification failed:', err.message);
            return res.status(403).json({ error: 'Invalid token' });
        }
        req.user = user;
        next();
    });
};

// User Registration
app.post('/api/register', async (req, res) => {
    console.log('Registration attempt:', { username: req.body.username, email: req.body.email });
    
    const { username, email, password } = req.body;

    // Validation
    if (!username || !email || !password) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);

        db.run(
            'INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
            [username, email, hashedPassword],
            function(err) {
                if (err) {
                    console.error('Registration error:', err.message);
                    if (err.message.includes('UNIQUE constraint failed')) {
                        if (err.message.includes('email')) {
                            return res.status(400).json({ error: 'Email already exists' });
                        } else {
                            return res.status(400).json({ error: 'Username already exists' });
                        }
                    }
                    return res.status(500).json({ error: 'Registration failed' });
                }

                const token = jwt.sign({ userId: this.lastID, username }, 'your-secret-key', { expiresIn: '24h' });
                console.log('User registered successfully:', { id: this.lastID, username });
                
                res.status(201).json({ 
                    message: 'Account created successfully! Welcome to Finance Copilot!',
                    token,
                    user: { id: this.lastID, username, email }
                });
            }
        );
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// User Login
app.post('/api/login', (req, res) => {
    console.log('Login attempt:', { email: req.body.email });
    
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
        if (err) {
            console.error('Login database error:', err);
            return res.status(500).json({ error: 'Login failed' });
        }
        
        if (!user) {
            console.log('User not found:', email);
            return res.status(400).json({ error: 'Invalid email or password' });
        }

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            console.log('Invalid password for user:', email);
            return res.status(400).json({ error: 'Invalid email or password' });
        }

        const token = jwt.sign({ userId: user.id, username: user.username }, 'your-secret-key', { expiresIn: '24h' });
        console.log('Login successful:', { id: user.id, username: user.username });
        
        res.json({ 
            message: 'Welcome back!',
            token,
            user: { id: user.id, username: user.username, email: user.email }
        });
    });
});

// AI Chat endpoint
app.post('/api/chat', authenticateToken, async (req, res) => {
    const { message } = req.body;
    const userId = req.user.userId;

    console.log('Chat message from user', userId, ':', message);

    if (!message || message.trim() === '') {
        return res.status(400).json({ error: 'Message is required' });
    }

    try {
        // Get user's recent transactions from database
        db.all(
            'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
            [userId],
            async (err, userTransactions) => {
                if (err) {
                    console.error('Database error:', err);
                    return res.status(500).json({ error: 'Failed to fetch transaction data' });
                }

                // Prepare context for AI
                const transactionSummary = userTransactions.length > 0 
                    ? `Recent transactions: ${userTransactions.map(t => 
                        `${t.type} of $${t.amount} for ${t.description} (${t.category}) on ${t.date}`
                      ).join(', ')}`
                    : 'No recent transactions available.';

                const systemPrompt = `You are Finance Copilot, a helpful AI financial advisor. 
                You provide personalized financial advice based on user data. Keep responses concise but helpful and encouraging.
                
                User's financial context: ${transactionSummary}
                
                Provide practical, actionable advice. If the user asks about budgeting, spending patterns, 
                savings, investments, or financial planning, use their transaction data to give personalized suggestions.
                Be encouraging and supportive while being realistic about financial goals.`;

                try {
                    // Check if OpenAI API key is available
                    if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'your-api-key-here') {
                        throw new Error('OpenAI API key not configured');
                    }

                    const completion = await openai.chat.completions.create({
                        model: "gpt-3.5-turbo",
                        messages: [
                            { role: "system", content: systemPrompt },
                            { role: "user", content: message }
                        ],
                        max_tokens: 300,
                        temperature: 0.7,
                    });

                    const aiResponse = completion.choices[0].message.content;
                    console.log('AI response generated successfully');

                    res.json({
                        success: true,
                        message: aiResponse,
                        timestamp: new Date().toISOString()
                    });

                } catch (openaiError) {
                    console.error('OpenAI API error:', openaiError.message);
                    
                    // Smart fallback responses based on user message
                    let fallbackResponse;
                    const lowerMessage = message.toLowerCase();
                    
                    if (lowerMessage.includes('budget')) {
                        fallbackResponse = "For budgeting, I recommend the 50/30/20 rule: 50% for needs, 30% for wants, and 20% for savings. Track your expenses regularly to stay on top of your financial goals!";
                    } else if (lowerMessage.includes('save') || lowerMessage.includes('saving')) {
                        fallbackResponse = "Start saving by setting up automatic transfers to a separate savings account. Even $25-50 per week adds up quickly! Emergency funds should cover 3-6 months of expenses.";
                    } else if (lowerMessage.includes('debt')) {
                        fallbackResponse = "For debt management, consider the debt snowball method (pay minimums on all debts, then focus extra payments on the smallest balance) or avalanche method (focus on highest interest rates first).";
                    } else if (lowerMessage.includes('invest')) {
                        fallbackResponse = "Before investing, ensure you have an emergency fund. Consider low-cost index funds for long-term growth. Start small and increase gradually as you learn more about investing.";
                    } else {
                        fallbackResponse = "I'm here to help with your finances! Try asking about budgeting, saving strategies, debt management, or spending analysis. I can provide personalized advice based on your transaction history.";
                    }
                    
                    res.json({
                        success: true,
                        message: fallbackResponse + "\n\n(Note: AI service temporarily unavailable - showing helpful financial tip instead)",
                        timestamp: new Date().toISOString()
                    });
                }
            }
        );

    } catch (error) {
        console.error('Chat endpoint error:', error);
        res.status(500).json({ error: 'Failed to process chat message' });
    }
});

// Transaction endpoints
app.get('/api/transactions', authenticateToken, (req, res) => {
    const userId = req.user.userId;
    
    db.all(
        'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC',
        [userId],
        (err, rows) => {
            if (err) {
                console.error('Get transactions error:', err);
                return res.status(500).json({ error: 'Failed to fetch transactions' });
            }
            
            console.log(`Retrieved ${rows.length} transactions for user ${userId}`);
            res.json({ transactions: rows });
        }
    );
});

app.post('/api/transactions', authenticateToken, (req, res) => {
    const { description, amount, type, category, date } = req.body;
    const userId = req.user.userId;

    // Validation
    if (!description || !amount || !type || !category || !date) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    if (amount <= 0) {
        return res.status(400).json({ error: 'Amount must be greater than 0' });
    }

    if (!['income', 'expense'].includes(type)) {
        return res.status(400).json({ error: 'Type must be income or expense' });
    }

    console.log('Adding transaction for user', userId, ':', { description, amount, type, category });

    db.run(
        'INSERT INTO transactions (user_id, description, amount, type, category, date) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, description, amount, type, category, date],
        function(err) {
            if (err) {
                console.error('Add transaction error:', err);
                return res.status(500).json({ error: 'Failed to add transaction' });
            }
            
            console.log('Transaction added successfully, ID:', this.lastID);
            
            res.status(201).json({
                message: 'Transaction added successfully!',
                transaction: {
                    id: this.lastID,
                    description,
                    amount,
                    type,
                    category,
                    date
                }
            });
        }
    );
});

// Financial summary endpoint
app.get('/api/summary', authenticateToken, (req, res) => {
    const userId = req.user.userId;
    
    db.all(
        `SELECT 
            type,
            SUM(amount) as total,
            COUNT(*) as count
         FROM transactions 
         WHERE user_id = ? 
         GROUP BY type`,
        [userId],
        (err, summaryRows) => {
            if (err) {
                console.error('Get summary error:', err);
                return res.status(500).json({ error: 'Failed to fetch summary' });
            }

            // Calculate totals
            let totalIncome = 0;
            let totalExpenses = 0;
            let transactionCount = 0;

            summaryRows.forEach(row => {
                if (row.type === 'income') {
                    totalIncome = row.total;
                }
                if (row.type === 'expense') {
                    totalExpenses = row.total;
                }
                transactionCount += row.count;
            });

            const balance = totalIncome - totalExpenses;

            console.log(`Summary for user ${userId}:`, { totalIncome, totalExpenses, balance, transactionCount });

            res.json({
                summary: {
                    totalIncome: totalIncome || 0,
                    totalExpenses: totalExpenses || 0,
                    balance,
                    transactionCount
                }
            });
        }
    );
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Handle 404
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    db.close((err) => {
        if (err) {
            console.error('Error closing database:', err);
        } else {
            console.log('💾 Database closed.');
        }
        process.exit(0);
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🔥 Server running at http://localhost:${PORT}`);
    console.log('💡 Ready to build your AI Finance Copilot!');
    console.log('📋 Available endpoints:');
    console.log('   GET  / - Health check');
    console.log('   POST /api/register - User registration');
    console.log('   POST /api/login - User login');
    console.log('   GET  /api/transactions - Get user transactions');
    console.log('   POST /api/transactions - Add transaction');
    console.log('   GET  /api/summary - Get financial summary');
    console.log('   POST /api/chat - AI chat assistant');
});