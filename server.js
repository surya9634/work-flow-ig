require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();
const port = process.env.PORT || 10000;

// Enhanced startup logging
console.log('🚀 Starting Workflow SaaS Server');
console.log('--------------------------------');
console.log('Environment Configuration:');
console.log(`PORT: ${port}`);
console.log(`INSTAGRAM_APP_ID: ${process.env.INSTAGRAM_APP_ID ? '1477959410285896' : '❌ MISSING'}`);
console.log(`INSTAGRAM_APP_SECRET: ${process.env.INSTAGRAM_APP_SECRET ? '8ccbc2e1a98cecf839bffa956928ba73' : '❌ MISSING'}`);
console.log(`REDIRECT_URI: ${process.env.REDIRECT_URI || 'https://work-flow-ig-1.onrender.com/auth/callback'}`);
console.log('--------------------------------');

// Validate critical environment variables
if (!process.env.INSTAGRAM_APP_ID) {
  console.error('❌ Critical Error: INSTAGRAM_APP_ID environment variable is missing!');
  process.exit(1);
}

if (!process.env.INSTAGRAM_APP_SECRET) {
  console.error('❌ Critical Error: INSTAGRAM_APP_SECRET environment variable is missing!');
  process.exit(1);
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Instagram API Configuration
const INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_ID;
const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://work-flow-ig-1.onrender.com/auth/callback';
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'WORKFLOW_VERIFY_TOKEN';

// In-memory storage
const users = new Map();
const configurations = new Map();

// Error serialization function
function serializeError(err) {
  if (!err) return 'Unknown error';
  
  if (err instanceof Error) {
    const errorObj = {
      name: err.name,
      message: err.message,
      stack: err.stack
    };
    
    if (err.response) {
      errorObj.response = {
        status: err.response.status,
        data: err.response.data,
        headers: err.response.headers
      };
    }
    
    return JSON.stringify(errorObj, null, 2);
  }
  
  return JSON.stringify(err, null, 2);
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Instagram Login
app.get('/auth/instagram', (req, res) => {
  try {
    const scopes = [
      'instagram_business_basic',
      'instagram_business_manage_messages',
      'instagram_business_manage_comments',
      'instagram_business_content_publish',
      'instagram_business_manage_insights'
    ].join(',');

    const authUrl = `https://www.instagram.com/oauth/authorize?force_reauth=true&client_id=${INSTAGRAM_APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${scopes}`;
    
    console.log('🔗 Redirecting to Instagram Auth URL:', authUrl);
    res.redirect(authUrl);
  } catch (err) {
    console.error('🔥 Login redirect error:', serializeError(err));
    res.status(500).send('Server error during Instagram login');
  }
});

// Instagram Callback with retry mechanism
app.get('/auth/callback', async (req, res) => {
  try {
    console.log('📬 Received Instagram callback:', req.query);
    const { code, error, error_reason } = req.query;
    
    if (error) {
      throw new Error(`OAuth error: ${error_reason || 'unknown'} - ${error}`);
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

    console.log('🔄 Exchanging code for access token...');
    const tokenResponse = await axios.post(
      'https://api.instagram.com/oauth/access_token',
      tokenData,
      {
        headers: { 
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-IG-App-ID': INSTAGRAM_APP_ID
        },
        timeout: 15000  // 15 seconds timeout
      }
    );

    if (!tokenResponse.data || !tokenResponse.data.access_token) {
      throw new Error('Invalid token response: ' + JSON.stringify(tokenResponse.data));
    }

    console.log('✅ Token exchange successful');
    const { access_token, user_id } = tokenResponse.data;

    // Get user profile with retry mechanism
    let profileResponse;
    let retryCount = 0;
    const maxRetries = 3;
    const retryDelays = [2000, 4000, 8000]; // 2s, 4s, 8s
    
    while (retryCount <= maxRetries) {
      try {
        console.log(`👤 Fetching user profile (attempt ${retryCount + 1} of ${maxRetries + 1})...`);
        profileResponse = await axios.get(`https://graph.instagram.com/me`, {
          params: { fields: 'id,username', access_token },
          headers: { 'X-IG-App-ID': INSTAGRAM_APP_ID },
          timeout: 20000  // 20 seconds timeout
        });

        if (!profileResponse.data || !profileResponse.data.username) {
          throw new Error('Invalid profile response: ' + JSON.stringify(profileResponse.data));
        }
        
        break; // Break out of loop if successful
      } catch (err) {
        if (retryCount >= maxRetries) {
          console.error(`🔥 Failed after ${maxRetries + 1} attempts`);
          throw err;
        }
        
        const delay = retryDelays[retryCount];
        console.log(`⚠️ Profile fetch failed, retrying in ${delay/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        retryCount++;
      }
    }

    console.log(`👋 User authenticated: ${profileResponse.data.username} (ID: ${user_id})`);
    
    // Store user data
    const userData = {
      access_token,
      username: profileResponse.data.username,
      instagram_id: user_id,
      last_login: new Date()
    };
    users.set(user_id, userData);

    res.redirect(`/dashboard.html?user_id=${user_id}`);
  } catch (err) {
    const errorMsg = serializeError(err);
    console.error('🔥 Authentication error:', errorMsg);
    
    // User-friendly error message
    let userMessage = 'Instagram login failed. Please try again.';
    
    if (err.response) {
      if (err.response.data && err.response.data.error_message) {
        userMessage = err.response.data.error_message;
      } else if (err.response.status === 400) {
        userMessage = 'Invalid request to Instagram API';
      } else if (err.response.status === 500) {
        userMessage = 'Temporary Instagram API issue - please try again later';
      }
    } else if (err.message.includes('timeout')) {
      userMessage = 'Connection to Instagram timed out';
    } else if (err.message.includes('Invalid profile response')) {
      userMessage = 'Could not retrieve your Instagram profile';
    }
    
    res.redirect(`/?error=auth_failed&message=${encodeURIComponent(userMessage)}`);
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
    console.log(`⚙️ Configuration saved for user ${userId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('🔥 Configuration error:', serializeError(err));
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
  } catch (err) {
    console.error('🔥 User info error:', serializeError(err));
    res.status(500).json({ error: 'Server error' });
  }
});

// Webhook Setup
app.get('/webhook', (req, res) => {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    console.log('🔔 Webhook verification request:', req.query);

    if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
      console.log('✅ Webhook verified successfully');
      res.status(200).send(challenge);
    } else {
      console.log('❌ Webhook verification failed');
      res.sendStatus(403);
    }
  } catch (err) {
    console.error('🔥 Webhook verification error:', serializeError(err));
    res.sendStatus(500);
  }
});

// Handle Instagram Events
app.post('/webhook', async (req, res) => {
  try {
    console.log('📩 Received webhook event:', req.body);
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
  } catch (err) {
    console.error('🔥 Webhook processing error:', serializeError(err));
    res.status(500).json({ error: 'Server error' });
  }
});

// Comment Handler
async function handleCommentEvent(commentData) {
  try {
    const { media_id, text, username } = commentData;
    console.log(`💬 New comment from ${username}: ${text}`);

    for (const [userId, user] of users.entries()) {
      try {
        const mediaResponse = await axios.get(`https://graph.instagram.com/${media_id}`, {
          params: {
            fields: 'owner',
            access_token: user.access_token
          },
          headers: { 'X-IG-App-ID': INSTAGRAM_APP_ID },
          timeout: 10000
        });

        const owner_id = mediaResponse.data.owner.id;

        if (configurations.has(owner_id)) {
          const { keyword, response } = configurations.get(owner_id);

          if (text.toLowerCase().includes(keyword.toLowerCase())) {
            console.log(`🔑 Keyword match: "${keyword}" in comment by ${username}`);
            
            const messageText = response.replace(/{username}/g, username);
            console.log(`✉️ Sending DM to ${username}: ${messageText.substring(0, 50)}...`);
            
            await axios.post(`https://graph.instagram.com/v18.0/${owner_id}/messages`, {
              recipient: { username },
              message: { text: messageText }
            }, {
              headers: {
                'Authorization': `Bearer ${user.access_token}`,
                'Content-Type': 'application/json',
                'X-IG-App-ID': INSTAGRAM_APP_ID
              },
              timeout: 15000
            });

            console.log(`✅ DM sent to ${username} for keyword "${keyword}"`);
          }
        }
      } catch (err) {
        console.error(`🔥 Comment handling error for user ${userId}:`, serializeError(err));
      }
    }
  } catch (err) {
    console.error('🔥 Event processing error:', serializeError(err));
  }
}

// Debug endpoint
app.get('/debug', (req, res) => {
  res.json({
    status: 'running',
    app_id: INSTAGRAM_APP_ID,
    redirect_uri: REDIRECT_URI,
    users_count: users.size,
    configs_count: configurations.size,
    environment: process.env.NODE_ENV,
    server_time: new Date().toISOString()
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    version: '1.0.0',
    uptime: process.uptime()
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('🔥 Global error handler:', serializeError(err));
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(port, () => {
  console.log('--------------------------------');
  console.log(`🚀 Server running on port ${port}`);
  console.log(`🔗 Redirect URI: ${REDIRECT_URI}`);
  if (process.env.RENDER) {
    console.log(`🌐 Live at: https://${process.env.RENDER_EXTERNAL_HOSTNAME}`);
  }
  console.log('--------------------------------');
  console.log('✅ Ready for Instagram logins');
});
