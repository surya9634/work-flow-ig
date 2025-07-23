require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const CONFIG = {
  FACEBOOK_APP_ID: process.env.FACEBOOK_APP_ID,
  FACEBOOK_APP_SECRET: process.env.FACEBOOK_APP_SECRET,
  REDIRECT_URI: process.env.REDIRECT_URI || `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/auth/instagram/callback`,
  WEBHOOK_VERIFY_TOKEN: process.env.WEBHOOK_VERIFY_TOKEN || 'instabot_webhook_token',
  INSTAGRAM_API_VERSION: 'v19.0'
};

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Instagram OAuth Route
app.get('/auth/instagram', (req, res) => {
  const state = uuidv4();
  
  const authUrl = `https://www.instagram.com/accounts/login/?next=/oauth/authorize?` +
    `client_id=${CONFIG.FACEBOOK_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(CONFIG.REDIRECT_URI)}` +
    `&state=${state}` +
    `&response_type=code` +
    `&scope=instagram_basic,instagram_manage_comments,instagram_manage_messages,pages_show_list`;
  
  res.redirect(authUrl);
});

// OAuth Callback
app.get('/auth/instagram/callback', async (req, res) => {
  const { code } = req.query;
  
  try {
    // In a real app, exchange code for access token
    res.redirect('/?session=connected');
  } catch (error) {
    console.error('OAuth Error:', error);
    res.redirect('/?error=auth_failed');
  }
});

// Webhook Endpoint
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === CONFIG.WEBHOOK_VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', (req, res) => {
  // Process Instagram webhook events
  console.log('Webhook received:', req.body);
  res.sendStatus(200);
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`OAuth URL: ${CONFIG.REDIRECT_URI.replace('/callback', '')}`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
});
