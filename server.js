// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const CONFIG = {
  FACEBOOK_APP_ID: process.env.FACEBOOK_APP_ID,
  FACEBOOK_APP_SECRET: process.env.FACEBOOK_APP_SECRET,
  REDIRECT_URI: process.env.REDIRECT_URI || `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/auth/instagram/callback`,
  WEBHOOK_VERIFY_TOKEN: process.env.WEBHOOK_VERIFY_TOKEN || 'instabot_webhook_token',
  INSTAGRAM_API_VERSION: 'v19.0',
  SESSION_SECRET: process.env.SESSION_SECRET || 'your_session_secret'
};

// In-memory storage for demo
const users = {};
const sessions = {};

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public')); // Serve frontend files

// Instagram OAuth Routes
app.get('/auth/instagram', (req, res) => {
  const state = uuidv4();
  sessions[state] = { state };
  
  const authUrl = `https://www.instagram.com/accounts/login/?next=/oauth/authorize?` +
    `client_id=${CONFIG.FACEBOOK_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(CONFIG.REDIRECT_URI)}` +
    `&state=${state}` +
    `&response_type=code` +
    `&scope=instagram_basic,instagram_manage_comments,instagram_manage_messages,pages_show_list`;
  
  res.redirect(authUrl);
});

app.get('/auth/instagram/callback', async (req, res) => {
  const { code, state } = req.query;
  
  // Validate state
  if (!sessions[state]) {
    return res.status(401).json({ error: 'Invalid state parameter' });
  }
  
  try {
    // Exchange code for access token
    const tokenResponse = await axios.post(
      `https://api.instagram.com/oauth/access_token`,
      {
        client_id: CONFIG.FACEBOOK_APP_ID,
        client_secret: CONFIG.FACEBOOK_APP_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: CONFIG.REDIRECT_URI,
        code
      },
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    
    const { access_token, user_id } = tokenResponse.data;
    
    // Get user profile
    const profileResponse = await axios.get(
      `https://graph.instagram.com/${user_id}`,
      {
        params: {
          fields: 'id,username,account_type',
          access_token
        }
      }
    );
    
    const userProfile = profileResponse.data;
    
    // Store user data
    users[user_id] = {
      id: user_id,
      username: userProfile.username,
      access_token,
      connected_at: new Date()
    };
    
    // Create session
    const sessionId = uuidv4();
    sessions[sessionId] = {
      userId: user_id,
      expires: Date.now() + 1000 * 60 * 60 * 24 // 24 hours
    };
    
    // Redirect to dashboard with session ID
    res.redirect(`/dashboard.html?session=${sessionId}`);
  } catch (error) {
    console.error('OAuth Error:', error.response?.data || error.message);
    handleOAuthError(error, res);
  }
});

// Webhook endpoint
app.get('/webhook', (req, res) => {
  // Verification for webhook
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  if (mode === 'subscribe' && token === CONFIG.WEBHOOK_VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    console.log('Webhook verification failed');
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  const { object, entry } = req.body;
  
  if (object === 'instagram') {
    for (const item of entry) {
      for (const change of item.changes) {
        if (change.field === 'comments') {
          await handleComment(change.value);
        }
      }
    }
  }
  
  res.sendStatus(200);
});

// Auto-reply logic
async function handleComment(commentData) {
  const { text, from, id: commentId, media_id } = commentData;
  const triggerPhrases = ['send me', 'please share', 'dm me', 'info', 'details'];
  
  const shouldReply = triggerPhrases.some(phrase => 
    text.toLowerCase().includes(phrase)
  );
  
  if (shouldReply) {
    console.log(`Trigger detected in comment: "${text}" by @${from.username}`);
    
    try {
      // Find user who owns the media
      const mediaOwnerId = await findMediaOwner(media_id);
      
      if (!mediaOwnerId || !users[mediaOwnerId]) {
        console.error('Media owner not found');
        return;
      }
      
      const userAccessToken = users[mediaOwnerId].access_token;
      
      // Send DM to the commenter
      await axios.post(
        `https://graph.instagram.com/${CONFIG.INSTAGRAM_API_VERSION}/${from.id}/messages`,
        {
          recipient: { id: from.id },
          message: { 
            text: "Thanks for your interest! We've sent you a DM with more details." 
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${userAccessToken}`
          }
        }
      );
      
      console.log(`Sent DM to @${from.username}`);
      
      // Reply to the comment
      await axios.post(
        `https://graph.instagram.com/${CONFIG.INSTAGRAM_API_VERSION}/${commentId}/replies`,
        {
          message: "Hi! We've sent you a direct message with the information you requested."
        },
        {
          headers: {
            'Authorization': `Bearer ${userAccessToken}`
          }
        }
      );
      
      console.log(`Replied to comment by @${from.username}`);
    } catch (error) {
      console.error('Auto-reply Error:', error.response?.data || error.message);
    }
  }
}

// Helper to find media owner
async function findMediaOwner(mediaId) {
  // In a real implementation, you would query your database
  // For demo, we'll just return the first user
  const userIds = Object.keys(users);
  return userIds.length > 0 ? userIds[0] : null;
}

// Error handling
function handleOAuthError(error, res) {
  const errorData = error.response?.data?.error || {};
  let errorMessage = 'Authentication failed. Please try again.';
  
  switch (errorData.code) {
    case 190:
      errorMessage = 'Invalid platform app configuration. Please check your app settings.';
      break;
    case 10:
      errorMessage = 'This app is not whitelisted for business use. Contact your Meta Business Partner.';
      break;
  }
  
  res.status(400).json({ error: errorMessage });
}

// User session validation
app.get('/api/user', (req, res) => {
  const sessionId = req.query.session;
  
  if (!sessionId || !sessions[sessionId] || sessions[sessionId].expires < Date.now()) {
    return res.status(401).json({ error: 'Invalid session' });
  }
  
  const userId = sessions[sessionId].userId;
  const user = users[userId];
  
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  res.json({
    id: user.id,
    username: user.username,
    connected_at: user.connected_at
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Instagram OAuth URL: ${CONFIG.REDIRECT_URI.replace('/callback', '')}`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
  console.log(`Dashboard: http://localhost:${PORT}/dashboard.html`);
});