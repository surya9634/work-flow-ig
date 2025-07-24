require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const bodyParser = require('body-parser');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const CONFIG = {
  FACEBOOK_APP_ID: process.env.FACEBOOK_APP_ID,
  FACEBOOK_APP_SECRET: process.env.FACEBOOK_APP_SECRET,
  REDIRECT_URI: process.env.REDIRECT_URI || 'https://yourdomain.com/auth/instagram/callback',
  WEBHOOK_VERIFY_TOKEN: process.env.WEBHOOK_VERIFY_TOKEN,
  INSTAGRAM_API_VERSION: 'v19.0',
  SESSION_SECRET: process.env.SESSION_SECRET || 'complex-secret-key'
};

// Session middleware
app.use(session({
  secret: CONFIG.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { 
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    secure: process.env.NODE_ENV === 'production'
  }
}));

// In-memory storage for demo (use database in production)
const users = {};

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Instagram OAuth Routes
app.get('/auth/instagram', (req, res) => {
  const state = uuidv4();
  req.session.oauthState = state;
  
  const authUrl = `https://www.facebook.com/${CONFIG.INSTAGRAM_API_VERSION}/dialog/oauth?` +
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
  if (!req.session.oauthState || req.session.oauthState !== state) {
    return res.status(401).send('Invalid state parameter');
  }
  
  try {
    // Exchange code for access token
    const tokenResponse = await axios.get(
      `https://graph.facebook.com/${CONFIG.INSTAGRAM_API_VERSION}/oauth/access_token`,
      {
        params: {
          client_id: CONFIG.FACEBOOK_APP_ID,
          client_secret: CONFIG.FACEBOOK_APP_SECRET,
          redirect_uri: CONFIG.REDIRECT_URI,
          code
        }
      }
    );
    
    const { access_token } = tokenResponse.data;
    
    // Get user profile
    const profileResponse = await axios.get(
      `https://graph.instagram.com/${CONFIG.INSTAGRAM_API_VERSION}/me`,
      {
        params: {
          fields: 'id,username',
          access_token
        }
      }
    );
    
    const userProfile = profileResponse.data;
    const userId = userProfile.id;
    
    // Store user data
    users[userId] = {
      id: userId,
      username: userProfile.username,
      access_token,
      connected_at: new Date()
    };
    
    // Store user in session
    req.session.userId = userId;
    
    // Redirect to dashboard
    res.redirect('/dashboard.html');
  } catch (error) {
    console.error('OAuth Error:', error.response?.data || error.message);
    handleOAuthError(error, res);
  }
});

// Webhook endpoint
app.get('/webhook', (req, res) => {
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

// Auto-reply logic with DM
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
        `https://graph.facebook.com/${CONFIG.INSTAGRAM_API_VERSION}/${from.id}/messages`,
        {
          recipient: { id: from.id },
          message: { 
            text: "Thanks for your interest! Here's more information you requested:\n\n" +
                  "• Product details: https://example.com/products\n" +
                  "• Pricing: https://example.com/pricing\n" +
                  "• Contact us: https://example.com/contact\n\n" +
                  "Let us know if you have any other questions!"
          }
        },
        {
          params: { access_token: userAccessToken }
        }
      );
      
      console.log(`Sent DM to @${from.username}`);
      
      // Reply to the comment
      await axios.post(
        `https://graph.facebook.com/${CONFIG.INSTAGRAM_API_VERSION}/${commentId}/replies`,
        {
          message: "Hi! We've sent you a direct message with the information you requested. Please check your DMs!"
        },
        {
          params: { access_token: userAccessToken }
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
  
  res.status(400).send(errorMessage);
}

// User session validation
app.get('/api/user', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Invalid session' });
  }
  
  const userId = req.session.userId;
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
  console.log(`Webhook URL: https://yourdomain.com/webhook`);
});
