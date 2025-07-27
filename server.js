require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();
const port = process.env.PORT || 10000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Instagram API Configuration
const INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_ID;
const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'WORKFLOW_VERIFY_TOKEN';

// In-memory storage (Replace with database in production)
const users = new Map();
const configurations = new Map();

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Instagram Login (ManyChat style)
app.get('/auth/instagram', (req, res) => {
  const scopes = [
    'instagram_business_basic',
    'instagram_manage_comments',
    'instagram_manage_messages'
  ].join(',');

  const authUrl = `https://www.instagram.com/oauth/authorize?force_reauth=true&client_id=${INSTAGRAM_APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${scopes}`;
  res.redirect(authUrl);
});

// Instagram Callback
app.get('/auth/callback', async (req, res) => {
  try {
    const { code, error, error_reason } = req.query;
    if (error) {
      throw new Error(`OAuth error: ${error_reason} - ${error}`);
    }

    // Exchange code for access token
    const tokenResponse = await axios.post('https://api.instagram.com/oauth/access_token', null, {
      params: {
        client_id: INSTAGRAM_APP_ID,
        client_secret: INSTAGRAM_APP_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
        code
      }
    });

    const { access_token, user_id } = tokenResponse.data;

    // Get user profile using Instagram Graph API
    const profileResponse = await axios.get(`https://graph.instagram.com/${user_id}`, {
      params: {
        fields: 'id,username',
        access_token: access_token
      }
    });

    // Store user data
    const userData = {
      access_token,
      username: profileResponse.data.username,
      instagram_id: user_id,
      last_login: new Date()
    };
    users.set(user_id, userData);

    res.redirect(`/dashboard.html?user_id=${user_id}`);
  } catch (error) {
    console.error('Authentication error:', error.response ? error.response.data : error.message);
    let errorMessage = 'Instagram login failed. Please try again.';
    if (error.response && error.response.data && error.response.data.error_message) {
      errorMessage = error.response.data.error_message;
    }
    res.redirect(`/?error=auth_failed&message=${encodeURIComponent(errorMessage)}`);
  }
});

// Save Configuration
app.post('/configure', (req, res) => {
  try {
    const { userId, keyword, response } = req.body;
    if (!userId || !keyword || !response) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    configurations.set(userId, { keyword, response });
    res.json({ success: true });
  } catch (error) {
    console.error('Configuration error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get User Info
app.get('/user-info', (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'User ID required' });

    const user = users.get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      username: user.username,
      instagram_id: user.instagram_id
    });
  } catch (error) {
    console.error('User info error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Webhook Setup
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
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
        if (event.changes && event.changes[0].field === 'comments') {
          const commentData = event.changes[0].value;
          await handleCommentEvent(commentData);
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
  try {
    const { media_id, text, username } = commentData;

    // Iterate over all users to find the owner of the media
    for (const [userId, user] of users.entries()) {
      try {
        // Get media details to check owner
        const mediaResponse = await axios.get(`https://graph.instagram.com/${media_id}`, {
          params: {
            fields: 'owner',
            access_token: user.access_token
          }
        });

        const owner_id = mediaResponse.data.owner.id;

        // Check if the owner has a configuration
        if (configurations.has(owner_id)) {
          const { keyword, response } = configurations.get(owner_id);

          // Check if the comment contains the keyword (case insensitive)
          if (text.toLowerCase().includes(keyword.toLowerCase())) {
            // Send DM
            await axios.post(`https://graph.instagram.com/v18.0/${owner_id}/messages`, {
              recipient: { username },
              message: {
                text: response.replace(/{username}/g, username)
              }
            }, {
              headers: {
                'Authorization': `Bearer ${user.access_token}`,
                'Content-Type': 'application/json'
              }
            });

            console.log(`Sent DM to ${username} for keyword "${keyword}"`);
          }
        }
      } catch (error) {
        console.error('Comment handling error for user', userId, ':', error.response ? error.response.data : error.message);
      }
    }
  } catch (error) {
    console.error('Event processing error:', error);
  }
}

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  if (process.env.RENDER) {
    console.log(`Live at: https://${process.env.RENDER_EXTERNAL_HOSTNAME}`);
  }
});
