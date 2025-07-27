require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto'); // Added for signature verification
const app = express();
const port = process.env.PORT || 10000;

// Enhanced startup logging
console.log('🚀 Starting Workflow SaaS Server');
console.log('--------------------------------');
console.log('Environment Configuration:');
console.log(`PORT: ${port}`);
console.log(`INSTAGRAM_APP_ID: ${process.env.INSTAGRAM_APP_ID ? 'set' : '❌ MISSING'}`);
console.log(`INSTAGRAM_APP_SECRET: ${process.env.INSTAGRAM_APP_SECRET ? 'set' : '❌ MISSING'}`);
console.log(`FACEBOOK_APP_SECRET: ${process.env.FACEBOOK_APP_SECRET ? 'set' : '❌ MISSING'}`);
console.log(`REDIRECT_URI: ${process.env.REDIRECT_URI || 'https://work-flow-ig-1.onrender.com/auth/callback'}`);
console.log(`WEBHOOK_VERIFY_TOKEN: ${process.env.WEBHOOK_VERIFY_TOKEN || 'default'}`);
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

if (!process.env.FACEBOOK_APP_SECRET) {
  console.error('❌ Critical Error: FACEBOOK_APP_SECRET environment variable is missing!');
  process.exit(1);
}

// Middleware to capture raw body for signature verification
app.use((req, res, next) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks).toString('utf8');
    next();
  });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Instagram API Configuration
const INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_ID;
const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET;
const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://work-flow-ig-1.onrender.com/auth/callback';
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'WORKFLOW_VERIFY_TOKEN';

// In-memory storage
const users = new Map();
const configurations = new Map();

// Track used authorization codes to prevent reuse
const usedAuthorizationCodes = new Set();

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

// Facebook Webhook Subscription
async function setupWebhookSubscription(accessToken) {
  try {
    console.log('🔧 Setting up Facebook webhook subscription...');
    
    // Subscribe to Instagram comment events
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${INSTAGRAM_APP_ID}/subscriptions`,
      {
        object: 'instagram',
        callback_url: `${REDIRECT_URI.split('/auth')[0]}/webhook`,
        fields: 'comments',
        verify_token: WEBHOOK_VERIFY_TOKEN,
        access_token: `${INSTAGRAM_APP_ID}|${FACEBOOK_APP_SECRET}`
      }
    );
    
    console.log('✅ Webhook subscription successful:', response.data);
    return true;
  } catch (err) {
    console.error('🔥 Webhook subscription failed:', serializeError(err));
    return false;
  }
}

// Signature verification function
function verifySignature(payload, signature) {
  if (!signature || !FACEBOOK_APP_SECRET) {
    console.warn('⚠️ Signature verification skipped - missing signature or secret');
    return false;
  }
  
  const [algo, receivedSignature] = signature.split('=');
  if (algo !== 'sha256') {
    console.warn('⚠️ Unsupported signature algorithm:', algo);
    return false;
  }
  
  const computedSignature = crypto
    .createHmac('sha256', FACEBOOK_APP_SECRET)
    .update(payload)
    .digest('hex');
  
  const isValid = computedSignature === receivedSignature;
  if (!isValid) {
    console.warn('❌ Invalid signature:', {
      received: receivedSignature,
      computed: computedSignature
    });
  }
  
  return isValid;
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
      'instagram_basic',
      'instagram_manage_comments',
      'instagram_manage_messages',
      'instagram_content_publish',
      'pages_show_list'
    ].join(',');

    const authUrl = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${INSTAGRAM_APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${scopes}`;
    
    console.log('🔗 Redirecting to Instagram Auth URL:', authUrl);
    res.redirect(authUrl);
  } catch (err) {
    console.error('🔥 Login redirect error:', serializeError(err));
    res.status(500).send('Server error during Instagram login');
  }
});

// Instagram Callback with retry mechanism and code reuse prevention
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

    // Prevent authorization code reuse
    if (usedAuthorizationCodes.has(code)) {
      console.warn('⚠️ Authorization code reuse detected:', code);
      throw new Error('Authorization code has already been used');
    }
    
    // Mark code as used immediately
    usedAuthorizationCodes.add(code);

    // Exchange code for access token
    const tokenUrl = `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${INSTAGRAM_APP_ID}&redirect_uri=${REDIRECT_URI}&client_secret=${INSTAGRAM_APP_SECRET}&code=${code}`;
    
    console.log('🔄 Exchanging code for access token...');
    const tokenResponse = await axios.get(tokenUrl, {
      timeout: 15000  // 15 seconds timeout
    });

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
        // Use the /me endpoint with the access token
        profileResponse = await axios.get(`https://graph.instagram.com/v19.0/me`, {
          params: { 
            fields: 'id,username,profile_picture_url',
            access_token: access_token
          },
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
      profile_pic: profileResponse.data.profile_picture_url,
      instagram_id: user_id,
      last_login: new Date()
    };
    users.set(user_id, userData);

    // Setup webhook subscription
    await setupWebhookSubscription(access_token);

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
    } else if (err.message.includes('Authorization code has already been used')) {
      userMessage = 'This login link has already been used. Please start a new login.';
    }
    
    res.redirect(`/?error=auth_failed&message=${encodeURIComponent(userMessage)}`);
  }
});

// ... (rest of server.js remains the same as previously provided) ...
