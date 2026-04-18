const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// Load .env file manually
const envPath = path.resolve(__dirname, '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
envContent.split('\n').forEach(line => {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith('#')) {
    const [key, ...valueParts] = trimmed.split('=');
    if (key) process.env[key.trim()] = valueParts.join('=').trim();
  }
});

const API_KEY = process.env.ANTHROPIC_API_KEY;
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
  chatId: { type: String, required: true },
  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

// Chat session schema - stores chat metadata
const chatSchema = new mongoose.Schema({
  chatId: { type: String, required: true, unique: true },
  title: { type: String, default: 'New Chat' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Create models
const Message = mongoose.model('Message', messageSchema);
const Chat = mongoose.model('Chat', chatSchema);

// ==================== API ROUTES ====================

// 1. POST /api/chat - Send message and store response
app.post('/api/chat', async (req, res) => {
  const { message, chatId } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  // Generate chatId if not provided
  const currentChatId = chatId || 'chat_' + Date.now();

  try {
    // Get previous messages for context
    const previousMessages = await Message.find({ chatId: currentChatId })
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
      chatId: currentChatId,
      role: 'user',
      content: message
    });

    // Save assistant message to database
    await Message.create({
      chatId: currentChatId,
      role: 'assistant',
      content: assistantMessage
    });

    // Update chat timestamp
    await Chat.findOneAndUpdate(
      { chatId: currentChatId },
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
app.get('/api/messages/:chatId', async (req, res) => {
  const { chatId } = req.params;

  try {
    const messages = await Message.find({ chatId })
      .sort({ createdAt: 1 })
      .select('role content createdAt');

    res.json({ messages });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/chats - List all chat sessions with first message preview
app.get('/api/chats', async (req, res) => {
  try {
    const chats = await Chat.find()
      .sort({ updatedAt: -1 })
      .limit(20);

    // Get first message for each chat as preview
    const chatsWithPreviews = await Promise.all(
      chats.map(async (chat) => {
        const firstMessage = await Message.findOne({ chatId: chat.chatId })
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
app.delete('/api/chat/:chatId', async (req, res) => {
  const { chatId } = req.params;

  try {
    await Message.deleteMany({ chatId });
    await Chat.deleteOne({ chatId });

    res.json({ success: true });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/chats - Delete all chats
app.delete('/api/chats', async (req, res) => {
  try {
    await Message.deleteMany({});
    await Chat.deleteMany({});

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
