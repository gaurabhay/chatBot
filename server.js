const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Load .env file
require('dotenv').config();

const API_KEY = process.env.ANTHROPIC_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'chatbot-secret-key-2024';
console.log('API Key loaded:', API_KEY ? 'Yes - ' + API_KEY.substring(0, 15) + '...' : 'No');

const app = express();
const PORT = process.env.PORT || 3001;

// MongoDB connection string (from environment or default)
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/chatwithabhay';

console.log('MongoDB URI:', MONGO_URI ? MONGO_URI.substring(0, 30) + '...' : 'Not set');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ==================== MONGOOSE MODELS ====================

// Message schema - stores each individual message
const messageSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  chatId: { type: String, required: true },
  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

// Chat session schema - stores chat metadata
const chatSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  chatId: { type: String, required: true },
  title: { type: String, default: 'New Chat' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Compound index for user-specific queries
chatSchema.index({ userId: 1, chatId: 1 }, { unique: true });
messageSchema.index({ userId: 1, chatId: 1 });

// Create models
const Message = mongoose.model('Message', messageSchema);
const Chat = mongoose.model('Chat', chatSchema);

// ==================== USER MODEL ====================
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// ==================== AUTH MIDDLEWARE ====================
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// ==================== AUTH ROUTES ====================

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ email, password: hashedPassword });

    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      user: { email: user.email, id: user._id }
    });
  } catch (error) {
    console.error('Register error:', error.message);
    res.status(500).json({ error: 'Failed to register' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      user: { email: user.email, id: user._id }
    });
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// GET /api/auth/me - Get current user
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: { email: user.email, id: user._id } });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// ==================== API ROUTES (Protected) ====================

// 1. POST /api/chat - Send message and store response
app.post('/api/chat', authMiddleware, async (req, res) => {
  const { message, chatId } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  // Generate chatId if not provided
  const currentChatId = chatId || 'chat_' + Date.now();

  try {
    // Get previous messages for context (user-specific)
    const previousMessages = await Message.find({ userId: req.userId, chatId: currentChatId })
      .sort({ createdAt: 1 })
      .lean();

    // Build messages array for API
    const messagesForAPI = previousMessages.map(msg => ({
      role: msg.role,
      content: msg.content
    }));

    // Add current user message
    messagesForAPI.push({ role: 'user', content: message });

    // Call AI API (SkillBoss - OpenAI compatible)
    const response = await fetch('https://api.skillboss.co/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o',
        messages: messagesForAPI,
        max_tokens: 1024
      })
    });

    const data = await response.json();

    console.log("API Response status:", response.status);
    console.log("API Response:", JSON.stringify(data).substring(0, 1000));

    if (!response.ok) {
      console.log("API ERROR RESPONSE:", data);
      throw new Error(data.error?.message || "API request failed");
    }

    // Validate response structure
    if (!data || typeof data !== 'object') {
      console.log("INVALID API RESPONSE: not an object", data);
      throw new Error("Invalid API response");
    }

    if (!data.choices || !Array.isArray(data.choices) || !data.choices.length) {
      console.log("INVALID API RESPONSE:", data);
      throw new Error("No response from AI");
    }

    const assistantMessage = data.choices[0].message?.content || "No reply";
    // Save user message to database
    await Message.create({
      userId: req.userId,
      chatId: currentChatId,
      role: 'user',
      content: message
    });

    // Save assistant message to database
    await Message.create({
      userId: req.userId,
      chatId: currentChatId,
      role: 'assistant',
      content: assistantMessage
    });

    // Update chat timestamp
    await Chat.findOneAndUpdate(
      { userId: req.userId, chatId: currentChatId },
      { updatedAt: Date.now() },
      { upsert: true }
    );

    res.json({
      response: assistantMessage,
      chatId: currentChatId
    });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 2. GET /api/messages/:chatId - Fetch chat history
app.get('/api/messages/:chatId', authMiddleware, async (req, res) => {
  const { chatId } = req.params;

  try {
    const messages = await Message.find({ userId: req.userId, chatId })
      .sort({ createdAt: 1 })
      .select('role content createdAt');

    res.json({ messages });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/chats - List all chat sessions with first message preview
app.get('/api/chats', authMiddleware, async (req, res) => {
  try {
    const chats = await Chat.find({ userId: req.userId })
      .sort({ updatedAt: -1 })
      .limit(20);

    // Get first message for each chat as preview
    const chatsWithPreviews = await Promise.all(
      chats.map(async (chat) => {
        const firstMessage = await Message.findOne({ userId: req.userId, chatId: chat.chatId })
          .sort({ createdAt: 1 })
          .select('content');
        return {
          chatId: chat.chatId,
          title: chat.title,
          preview: firstMessage ? firstMessage.content.substring(0, 40) : 'New conversation',
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt
        };
      })
    );

    res.json({ chats: chatsWithPreviews });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/chat/:chatId - Delete a chat
app.delete('/api/chat/:chatId', authMiddleware, async (req, res) => {
  const { chatId } = req.params;

  try {
    await Message.deleteMany({ userId: req.userId, chatId });
    await Chat.deleteOne({ userId: req.userId, chatId });

    res.json({ success: true });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/chats - Delete all chats
app.delete('/api/chats', authMiddleware, async (req, res) => {
  try {
    await Message.deleteMany({ userId: req.userId });
    await Chat.deleteMany({ userId: req.userId });

    res.json({ success: true });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==================== SERVER START ====================

// Connect to MongoDB and start server
async function startServer() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB successfully!');

    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error.message);
    console.log('\nMake sure MongoDB is running locally or update MONGO_URI in .env');
    process.exit(1);
  }
}

startServer();
