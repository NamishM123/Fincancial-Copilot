# Finance Copilot

An AI-powered personal finance management application that helps users track expenses, manage budgets, and get personalized financial advice.

## Features

- **User Authentication**: Secure registration and login system
- **Transaction Management**: Add, view, and categorize income and expenses
- **Dashboard**: Real-time financial overview with balance, income, and expense summaries
- **AI Financial Assistant**: Get personalized financial advice based on your transaction history
- **Analytics**: Spending insights and financial trends (coming soon)

## Tech Stack

**Frontend:**
- HTML5, CSS3, JavaScript
- Responsive design with modern UI/UX
- Real-time dashboard updates

**Backend:**
- Node.js with Express.js
- SQLite database for data persistence
- JWT authentication
- OpenAI GPT-3.5 integration for AI chat

**Dependencies:**
- bcryptjs - Password hashing
- jsonwebtoken - JWT token generation
- cors - Cross-origin resource sharing
- openai - OpenAI API integration
- sqlite3 - Database management

## Setup Instructions

### Prerequisites
- Node.js (v14 or higher)
- npm package manager
- OpenAI API key

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/NamishM123/Fincancial-Copilot.git
   cd Fincancial-Copilot
   ```

2. **Install backend dependencies**
   ```bash
   cd backend
   npm install express sqlite3 bcryptjs jsonwebtoken cors openai dotenv
   ```

3. **Create environment file**
   ```bash
   touch .env
   ```
   Add your OpenAI API key:
   ```
   OPENAI_API_KEY=your_openai_api_key_here
   ```

4. **Start the backend server**
   ```bash
   node server.js
   ```
   Server will run on http://localhost:3000

5. **Open the frontend**
   - Open `frontend/index.html` in your web browser
   - Or serve it through a local web server

## Usage

1. **Register/Login**: Create an account or sign in with existing credentials
2. **Add Transactions**: Record your income and expenses with categories and dates
3. **View Dashboard**: Monitor your financial overview with real-time balance calculations
4. **Chat with AI**: Ask for personalized financial advice based on your spending patterns
5. **Analyze Spending**: Review transaction history and spending categories

## API Endpoints

- `POST /api/register` - User registration
- `POST /api/login` - User authentication
- `GET /api/transactions` - Fetch user transactions
- `POST /api/transactions` - Add new transaction
- `GET /api/summary` - Get financial summary
- `POST /api/chat` - AI chat assistant

## Project Structure

```
Fincancial-Copilot/
├── backend/
│   ├── server.js          # Express server and API routes
│   ├── .env              # Environment variables (not tracked)
│   └── finance.db        # SQLite database (auto-generated)
├── frontend/
│   └── index.html        # Single-page application
├── .gitignore           # Git ignore rules
└── README.md           # Project documentation
```

## Security Features

- Password hashing with bcrypt
- JWT token-based authentication
- Environment variables for sensitive data
- Git ignore for API keys and database files
- CORS protection

## Future Enhancements

- Bank account integration (Plaid API)
- Advanced analytics and charts
- Budget goal setting
- Expense categorization with machine learning
- Mobile app development
- Receipt photo upload and parsing
- Multi-currency support

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/new-feature`)
3. Commit your changes (`git commit -m 'Add new feature'`)
4. Push to the branch (`git push origin feature/new-feature`)
5. Open a Pull Request

## License

This project is open source and available under the [MIT License](LICENSE).

## Support

If you encounter any issues or have questions, please open an issue on GitHub or contact the development team.

---

**Note**: This application requires an OpenAI API key for the AI chat functionality. Without it, the system will provide helpful fallback responses but won't have full AI capabilities.
