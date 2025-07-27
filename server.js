require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();
const port = process.env.PORT || 10000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Instagram API Configuration - USING YOUR APP ID
const INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_ID || '1477959410285896';
const INSTAGRAM_APP_SECRET = process.env.8ccbc2e1a98cecf839bffa956928ba73;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://work-flow-ig-1.onrender.com/auth/callback';
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'hello';

// Debugging output
console.log('Using Instagram App ID:', INSTAGRAM_APP_ID);
console.log('Using Redirect URI:', REDIRECT_URI);

// In-memory storage
const users = new Map();
const configurations = new Map();

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Instagram Login (Using your specific parameters)
app.get('/auth/instagram', (req, res) => {
  const scopes = [
    'instagram_business_basic',
    'instagram_business_manage_messages',
    'instagram_business_manage_comments',
    'instagram_business_content_publish',
    'instagram_business_manage_insights'
  ].join('%2C'); // URL-encoded comma

  // Using YOUR SPECIFIC APP ID AND REDIRECT URI
  const authUrl = `https://www.instagram.com/oauth/authorize?force_reauth=true&client_id=${INSTAGRAM_APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${scopes}`;
  
  console.log('Redirecting to Instagram Auth URL:', authUrl);
  res.redirect(authUrl);
});

// Instagram Callback
app.get('/auth/callback', async (req, res) => {
  try {
    console.log('Received Instagram callback:', req.query);
    const { code, error, error_reason } = req.query;
    
    if (error) {
      throw new Error(`OAuth error: ${error_reason} - ${error}`);
    }

    if (!code) {
      throw new Error('Authorization code is missing');
    }

    // Exchange code for access token
    const tokenData = new URLSearchParams();
    tokenData.append('client_id', INSTAGRAM_APP_ID);
    tokenData.append('client_secret', INSTAGRAM_APP_SECRET);
    tokenData.append('grant_type', 'authorization_code');
    tokenData.append('redirect_uri', REDIRECT_URI);
    tokenData.append('code', code);

    console.log('Exchanging code for token with:', tokenData.toString());

    const tokenResponse = await axios.post(
      'https://api.instagram.com/oauth/access_token',
      tokenData,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    console.log('Token response:', tokenResponse.data);
    const { access_token, user_id } = tokenResponse.data;

    // Get user profile
    const profileResponse = await axios.get(`https://graph.instagram.com/${user_id}`, {
      params: {
        fields: 'id,username',
        access_token: access_token
      }
    });

    console.log('Profile response:', profileResponse.data);

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
    
    if (error.response && error.response.data) {
      // Handle Instagram API errors
      if (error.response.data.error_message) {
        errorMessage = error.response.data.error_message;
      } else if (error.response.data.error) {
        errorMessage = `${error.response.data.error}: ${error.response.data.error_description}`;
      }
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

// Debug endpoint
app.get('/debug', (req, res) => {
  res.json({
    status: 'running',
    app_id: INSTAGRAM_APP_ID,
    redirect_uri: REDIRECT_URI,
    users_count: users.size,
    configs_count: configurations.size
  });
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Instagram App ID: ${INSTAGRAM_APP_ID}`);
  console.log(`Redirect URI: ${REDIRECT_URI}`);
  if (process.env.RENDER) {
    console.log(`Live at: https://${process.env.RENDER_EXTERNAL_HOSTNAME}`);
  }
});
