require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();
const port = process.env.PORT || 10000;

console.log('🚀 Starting Workflow SaaS Server');
console.log('--------------------------------');
console.log('Environment Configuration:');
console.log(`PORT: ${port}`);
console.log(`INSTAGRAM_APP_ID: ${process.env.INSTAGRAM_APP_ID ? 'Set' : '❌ MISSING'}`);
console.log(`INSTAGRAM_APP_SECRET: ${process.env.INSTAGRAM_APP_SECRET ? 'Set' : '❌ MISSING'}`);
console.log(`REDIRECT_URI: ${process.env.REDIRECT_URI || 'https://work-flow-ig-1.onrender.com/auth/callback'}`);
console.log('--------------------------------');

// Enhanced app credentials validation
if (!process.env.INSTAGRAM_APP_ID || !process.env.INSTAGRAM_APP_SECRET) {
  console.error('❌ Critical Error: Missing Instagram credentials!');
  if (!process.env.INSTAGRAM_APP_ID) {
    console.error('INSTAGRAM_APP_ID is required');
  }
  if (!process.env.INSTAGRAM_APP_SECRET) {
    console.error('INSTAGRAM_APP_SECRET is required');
  }
  console.error('Please verify your environment variables and Facebook App configuration');
  process.exit(1);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_ID;
const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://work-flow-ig-1.onrender.com/auth/callback';

const users = new Map();
const configurations = new Map();
const usedAuthorizationCodes = new Set();

// Enhanced error serialization
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
    
    if (err.config) {
      errorObj.config = {
        url: err.config.url,
        method: err.config.method,
        params: err.config.params ? {
          ...err.config.params,
          client_secret: err.config.params.client_secret ? '***REDACTED***' : undefined,
          access_token: err.config.params.access_token ? '***REDACTED***' : undefined,
          fb_exchange_token: err.config.params.fb_exchange_token ? '***REDACTED***' : undefined
        } : undefined
      };
    }
    
    return JSON.stringify(errorObj, null, 2);
  }
  
  return JSON.stringify(err, null, 2);
}

// Enhanced token refresh with diagnostics
async function refreshInstagramToken(oldToken) {
  try {
    console.log('🔄 Attempting to refresh Instagram access token...');
    
    const params = {
      grant_type: 'fb_exchange_token',
      client_id: INSTAGRAM_APP_ID,
      client_secret: INSTAGRAM_APP_SECRET,
      fb_exchange_token: oldToken
    };
    
    console.log(`ℹ️ Refresh params: ${JSON.stringify({
      ...params,
      client_secret: '***REDACTED***',
      fb_exchange_token: `${oldToken.substring(0, 6)}...`
    })}`);
    
    const response = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
      params,
      timeout: 10000
    });

    if (response.data?.access_token) {
      console.log('✅ Token refresh successful');
      return {
        token: response.data.access_token,
        expiresIn: response.data.expires_in,
        expiresAt: Date.now() + (response.data.expires_in * 1000)
      };
    }
    
    throw new Error('Invalid token refresh response');
  } catch (error) {
    console.error('🔥 Token refresh error:', serializeError(error));
    return null;
  }
}

// Token verification with enhanced diagnostics
async function verifyToken(userId) {
  const user = users.get(userId);
  if (!user) {
    console.error(`❌ User not found: ${userId}`);
    return false;
  }

  // Token expiration check with buffer
  const expirationBuffer = 300000; // 5 minutes
  if (Date.now() > user.expiresAt - expirationBuffer) {
    console.log(`⚠️ Token for ${userId} expiring soon (${new Date(user.expiresAt).toISOString()}), refreshing...`);
    const newTokenData = await refreshInstagramToken(user.access_token);
    if (newTokenData) {
      user.access_token = newTokenData.token;
      user.expiresAt = newTokenData.expiresAt;
      users.set(userId, user);
      console.log(`✅ Token refreshed for ${userId}`);
    } else {
      console.error(`❌ Token refresh failed for ${userId}`);
      return false;
    }
  }

  try {
    console.log(`🔍 Verifying token for ${userId}`);
    const response = await axios.get(`https://graph.facebook.com/v19.0/me/accounts`, {
      params: { 
        access_token: user.access_token,
        fields: 'instagram_business_account'
      },
      timeout: 5000
    });
    
    return !!response.data?.data;
  } catch (error) {
    console.error(`🔥 Token verification failed for ${userId}:`, serializeError(error));
    return false;
  }
}

// Long-lived token exchange with enhanced error diagnostics
async function getLongLivedToken(shortLivedToken) {
  try {
    console.log('🔄 Exchanging for long-lived token...');
    
    const params = {
      grant_type: 'fb_exchange_token',
      client_id: INSTAGRAM_APP_ID,
      client_secret: INSTAGRAM_APP_SECRET,
      fb_exchange_token: shortLivedToken
    };
    
    console.log(`ℹ️ Exchange params: ${JSON.stringify({
      ...params,
      client_secret: '***REDACTED***',
      fb_exchange_token: `${shortLivedToken.substring(0, 6)}...`
    })}`);
    
    const response = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
      params,
      timeout: 10000
    });

    if (response.data?.access_token) {
      console.log('✅ Long-lived token obtained');
      return {
        token: response.data.access_token,
        expiresIn: response.data.expires_in,
        expiresAt: Date.now() + (response.data.expires_in * 1000)
      };
    }
    
    throw new Error('Invalid long-lived token response');
  } catch (error) {
    console.error('🔥 Long-lived token error:', serializeError(error));
    
    // Enhanced diagnostics for common issues
    if (error.response) {
      const { status, data } = error.response;
      console.error('🔍 Error details:', {
        status,
        errorCode: data?.error?.code,
        errorType: data?.error?.type,
        errorMessage: data?.error?.message
      });
      
      if (status === 400 && data?.error?.code === 101) {
        console.error('❌ Critical: App validation failed. Verify:');
        console.error('1. App ID and Secret are correct');
        console.error('2. App is in "Live" mode in Facebook Developer Portal');
        console.error('3. "Instagram Graph API" product is added to your app');
        console.error('4. Valid OAuth Redirect URI is configured');
      }
    }
    
    return null;
  }
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/auth/instagram', (req, res) => {
  try {
    const scope = 'instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments';
    const authUrl = `https://www.instagram.com/oauth/authorize?client_id=${INSTAGRAM_APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${scope}&response_type=code`;
    
    console.log('🔗 Redirecting to Instagram Auth URL:', authUrl);
    res.redirect(authUrl);
  } catch (err) {
    console.error('🔥 Login redirect error:', serializeError(err));
    res.status(500).send('Server error during Instagram login');
  }
});

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

    if (usedAuthorizationCodes.has(code)) {
      console.warn('⚠️ Authorization code reuse detected:', code);
      for (const [userId, userData] of users.entries()) {
        if (userData.code === code) {
          console.log(`↩️ Redirecting reused code to existing user: ${userId}`);
          return res.redirect(`/dashboard.html?user_id=${userId}`);
        }
      }
      throw new Error('Authorization code has already been used');
    }
    
    usedAuthorizationCodes.add(code);

    const tokenExchangeData = new URLSearchParams();
    tokenExchangeData.append('client_id', INSTAGRAM_APP_ID);
    tokenExchangeData.append('client_secret', INSTAGRAM_APP_SECRET);
    tokenExchangeData.append('grant_type', 'authorization_code');
    tokenExchangeData.append('redirect_uri', REDIRECT_URI);
    tokenExchangeData.append('code', code);

    console.log('🔄 Exchanging code for short-lived token...');
    const tokenResponse = await axios.post(
      'https://api.instagram.com/oauth/access_token',
      tokenExchangeData,
      {
        headers: { 
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-IG-App-ID': INSTAGRAM_APP_ID
        },
        timeout: 15000
      }
    );

    if (!tokenResponse.data?.access_token) {
      console.error('❌ Invalid token response:', tokenResponse.data);
      throw new Error('Invalid token response from Instagram');
    }

    console.log('✅ Short-lived token obtained');
    const shortLivedToken = tokenResponse.data.access_token;
    const user_id = String(tokenResponse.data.user_id);

    console.log(`ℹ️ User ID: ${user_id}`);
    console.log(`ℹ️ Token: ${shortLivedToken.substring(0, 10)}...`);

    // Exchange for long-lived token
    console.log('🔄 Attempting long-lived token exchange...');
    const tokenData = await getLongLivedToken(shortLivedToken);
    
    if (!tokenData) {
      throw new Error('Failed to obtain long-lived token');
    }
    
    const access_token = tokenData.token;
    const expiresAt = tokenData.expiresAt;

    // Get user profile
    console.log(`👤 Fetching user profile for ${user_id}...`);
    const profileResponse = await axios.get(`https://graph.facebook.com/v19.0/${user_id}`, {
      params: { 
        fields: 'id,username,profile_picture_url',
        access_token: access_token
      },
      timeout: 20000
    });

    if (!profileResponse.data?.username) {
      console.error('❌ Invalid profile response:', profileResponse.data);
      throw new Error('Failed to fetch user profile');
    }

    console.log(`👋 User authenticated: ${profileResponse.data.username} (ID: ${user_id})`);
    
    // Store user data with expiration
    const userData = {
      access_token,
      username: profileResponse.data.username,
      profile_pic: profileResponse.data.profile_picture_url,
      instagram_id: user_id,
      last_login: new Date(),
      expiresAt,
      code
    };
    users.set(user_id, userData);

    res.redirect(`/dashboard.html?user_id=${user_id}`);
  } catch (err) {
    const errorMsg = serializeError(err);
    console.error('🔥 Authentication error:', errorMsg);
    
    let userMessage = 'Instagram login failed. Please try again.';
    
    if (err.response) {
      if (err.response.data?.error_message) {
        userMessage = err.response.data.error_message;
      } else if (err.response.status === 400) {
        userMessage = 'Invalid request to Instagram API';
      } else if (err.response.status === 500) {
        userMessage = 'Temporary Instagram API issue - please try again later';
      } else if (err.response.status === 401) {
        userMessage = 'Session expired - please re-authenticate';
      }
    } else if (err.message.includes('timeout')) {
      userMessage = 'Connection to Instagram timed out';
    } else if (err.message.includes('Authorization code has already been used')) {
      userMessage = 'This login link has already been used. Please start a new login.';
    } else if (err.message.includes('Failed to obtain long-lived token')) {
      userMessage = 'Token exchange failed. Please verify your app configuration in Facebook Developer Portal.';
    }
    
    res.redirect(`/?error=auth_failed&message=${encodeURIComponent(userMessage)}`);
  }
});

app.get('/user-posts', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'User ID required' });

    const user = users.get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Verify token before proceeding
    const tokenValid = await verifyToken(userId);
    if (!tokenValid) {
      return res.status(401).json({ error: 'Instagram token is invalid or expired' });
    }

    const response = await axios.get(`https://graph.facebook.com/v19.0/${user.instagram_id}/media`, {
      params: {
        fields: 'id,caption,media_url,media_type,thumbnail_url',
        access_token: user.access_token
      }
    });

    const processedPosts = response.data.data.map(post => ({
      id: post.id,
      caption: post.caption || '',
      media_url: post.media_type === 'VIDEO' ? (post.thumbnail_url || '') : post.media_url,
      media_type: post.media_type
    }));

    res.json(processedPosts);
  } catch (err) {
    console.error('🔥 User posts error:', serializeError(err));
    
    let errorMessage = 'Error fetching posts';
    if (err.response) {
      if (err.response.status === 190) {
        errorMessage = 'Token expired - please re-authenticate';
      } else if (err.response.status === 400) {
        errorMessage = 'Invalid request to Instagram API';
      }
    }
    
    res.status(500).json({ error: errorMessage });
  }
});

app.get('/post-comments', async (req, res) => {
  try {
    const { userId, postId } = req.query;
    if (!userId || !postId) {
      return res.status(400).json({ error: 'User ID and Post ID required' });
    }

    const user = users.get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Verify token before proceeding
    const tokenValid = await verifyToken(userId);
    if (!tokenValid) {
      return res.status(401).json({ error: 'Instagram token is invalid or expired' });
    }

    const response = await axios.get(`https://graph.facebook.com/v19.0/${postId}/comments`, {
      params: {
        fields: 'id,text,username,timestamp',
        access_token: user.access_token
      }
    });

    res.json(response.data.data || []);
  } catch (err) {
    console.error('🔥 Post comments error:', serializeError(err));
    
    let errorMessage = 'Error fetching comments';
    if (err.response) {
      if (err.response.status === 190) {
        errorMessage = 'Token expired - please re-authenticate';
      } else if (err.response.status === 400) {
        errorMessage = 'Invalid request to Instagram API';
      }
    }
    
    res.status(500).json({ error: errorMessage });
  }
});

app.post('/configure', async (req, res) => {
  try {
    const { userId, postId, keyword, response } = req.body;
    if (!userId || !postId || !keyword || !response) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const user = users.get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Verify token before proceeding
    const tokenValid = await verifyToken(userId);
    if (!tokenValid) {
      return res.status(401).json({ error: 'Instagram token is invalid or expired' });
    }

    configurations.set(userId, { postId, keyword, response });
    console.log(`⚙️ Configuration saved for user ${userId} on post ${postId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('🔥 Configuration error:', serializeError(err));
    
    let errorMessage = 'Server error';
    if (err.response) {
      if (err.response.status === 400) {
        errorMessage = 'Invalid request to Instagram API';
      } else if (err.response.status === 404) {
        errorMessage = 'Post not found';
      } else if (err.response.status === 401) {
        errorMessage = 'Instagram token is invalid or expired';
      }
    } else if (err.message.includes('timeout')) {
      errorMessage = 'Connection to Instagram timed out';
    }
    
    res.status(500).json({ error: errorMessage });
  }
});

app.post('/send-manual-message', async (req, res) => {
  try {
    const { userId, username, message } = req.body;
    if (!userId || !username || !message) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const user = users.get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    console.log(`✉️ Sending manual DM to ${username}: ${message.substring(0, 50)}...`);
    
    // Verify token before sending
    const tokenValid = await verifyToken(userId);
    if (!tokenValid) {
      return res.status(401).json({ error: 'Instagram token is invalid or expired' });
    }

    await axios.post(`https://graph.facebook.com/v19.0/${user.instagram_id}/messages`, {
      recipient: { username },
      message: { text: message }
    }, {
      headers: {
        'Authorization': `Bearer ${user.access_token}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    console.log(`✅ Manual DM sent to ${username}`);
    res.json({ success: true });
  } catch (err) {
    console.error('🔥 Manual message error:', serializeError(err));
    
    let errorMessage = 'Error sending message';
    if (err.response) {
      if (err.response.status === 400) {
        errorMessage = 'Invalid request to Instagram API';
      } else if (err.response.status === 401) {
        errorMessage = 'Instagram token is invalid or expired';
      } else if (err.response.status === 403) {
        errorMessage = 'Permission denied by Instagram';
      } else if (err.response.status === 190) {
        errorMessage = 'Token expired - please re-authenticate';
      }
    }
    
    res.status(500).json({ error: errorMessage });
  }
});

app.get('/user-info', (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'User ID required' });

    const user = users.get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      username: user.username,
      instagram_id: user.instagram_id,
      profile_pic: user.profile_pic
    });
  } catch (err) {
    console.error('🔥 User info error:', serializeError(err));
    res.status(500).json({ error: 'Server error' });
  }
});

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
