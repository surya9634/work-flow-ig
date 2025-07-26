require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Instagram API Configuration
const INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_ID;
const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://work-flow-ig-1.onrender.com//auth/callback';

// In-memory storage (Use database in production)
const users = {};
const configurations = {};

// Routes
app.get('/', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

// Instagram Login
app.get('/auth/instagram', (req, res) => {
  const authUrl = `https://api.instagram.com/oauth/authorize?client_id=${INSTAGRAM_APP_ID}&redirect_uri=${REDIRECT_URI}&scope=user_profile,instagram_basic,instagram_manage_comments,instagram_manage_messages&response_type=code`;
  res.redirect(authUrl);
});

// Instagram Callback
app.get('/auth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const tokenResponse = await axios.post('https://api.instagram.com/oauth/access_token', 
      new URLSearchParams({
        client_id: INSTAGRAM_APP_ID,
        client_secret: INSTAGRAM_APP_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
        code
      })
    );

    const { access_token, user_id } = tokenResponse.data;
    users[user_id] = { access_token };
    
    // Get user profile
    const profileResponse = await axios.get(`https://graph.instagram.com/${user_id}?fields=id,username&access_token=${access_token}`);
    users[user_id].username = profileResponse.data.username;

    res.redirect(`/dashboard.html?user_id=${user_id}`);
  } catch (error) {
    console.error('Authentication error:', error.response.data);
    res.redirect('/?error=auth_failed');
  }
});

// Save Configuration
app.post('/configure', (req, res) => {
  const { userId, keyword, response } = req.body;
  configurations[userId] = { keyword, response };
  res.json({ success: true });
});

// Webhook Setup (For Instagram real-time updates)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === 'WORKFLOW_VERIFY_TOKEN') {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Handle Instagram Events
app.post('/webhook', async (req, res) => {
  try {
    const { object, entry } = req.body;
    
    if (object === 'instagram') {
      for (const event of entry) {
        if (event.messaging) {
          // Handle DM events
        } else if (event.changes) {
          // Handle comment events
          const { field, value } = event.changes[0];
          if (field === 'comments') {
            await handleCommentEvent(value);
          }
        }
      }
    }
    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Comment Handler
async function handleCommentEvent(commentData) {
  const { media_id, text, username } = commentData;
  
  // Find media owner
  const mediaResponse = await axios.get(`https://graph.instagram.com/${media_id}?fields=owner&access_token=${users[owner_id].access_token}`);
  const owner_id = mediaResponse.data.owner.id;
  
  // Check if owner has configuration
  if (configurations[owner_id]) {
    const { keyword, response } = configurations[owner_id];
    
    if (text.includes(keyword)) {
      // Send DM
      await axios.post(`https://graph.instagram.com/v18.0/${owner_id}/messages`, {
        recipient: { username },
        message: { text: response }
      }, {
        headers: { Authorization: `Bearer ${users[owner_id].access_token}` }
      });
    }
  }
}

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
