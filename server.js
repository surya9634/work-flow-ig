require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();
const port = process.env.PORT || 10000;

const INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_ID;
const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://work-flow-ig-1.onrender.com/auth/callback';
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'WORKFLOW_VERIFY_TOKEN';

if (!INSTAGRAM_APP_ID || !INSTAGRAM_APP_SECRET) {
  console.error('❌ Missing Instagram App credentials in env');
  process.exit(1);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== In-Memory Stores ==========
const users = new Map(); // key = instagram_id
const configurations = new Map(); // key = userId
const usedAuthorizationCodes = new Set();

// ========== Helper ==========
function serializeError(err) {
  if (!err) return 'Unknown error';
  if (err instanceof Error) {
    return JSON.stringify({
      name: err.name,
      message: err.message,
      stack: err.stack,
      response: err.response?.data
    }, null, 2);
  }
  return JSON.stringify(err, null, 2);
}

// ========== Routes ==========

// Redirect to IG Auth
app.get('/auth/instagram', (req, res) => {
  const authUrl = `https://www.instagram.com/oauth/authorize?force_reauth=true&client_id=${INSTAGRAM_APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=instagram_basic,instagram_content_publish,instagram_manage_insights,pages_show_list,instagram_manage_messages`;
  console.log('🔗 Redirecting to:', authUrl);
  res.redirect(authUrl);
});

// Instagram OAuth Callback
app.get('/auth/callback', async (req, res) => {
  try {
    const { code, error } = req.query;
    if (error || !code) throw new Error(`OAuth error: ${error || 'Missing code'}`);

    if (usedAuthorizationCodes.has(code)) {
      return res.redirect('/');
    }
    usedAuthorizationCodes.add(code);

    const tokenData = new URLSearchParams({
      client_id: INSTAGRAM_APP_ID,
      client_secret: INSTAGRAM_APP_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
      code
    });

    // Exchange IG code
    const tokenRes = await axios.post('https://api.instagram.com/oauth/access_token', tokenData, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const igUserAccessToken = tokenRes.data.access_token;
    const fbUserId = tokenRes.data.user_id;

    // Get Facebook Pages
    const pagesRes = await axios.get(`https://graph.facebook.com/v19.0/${fbUserId}/accounts`, {
      params: { access_token: igUserAccessToken }
    });

    const page = pagesRes.data.data?.[0];
    if (!page) throw new Error('No Facebook Page connected to this IG user');

    const pageAccessToken = page.access_token;
    const pageId = page.id;

    // Get IG Business Account
    const igRes = await axios.get(`https://graph.facebook.com/v19.0/${pageId}`, {
      params: {
        fields: 'instagram_business_account',
        access_token: pageAccessToken
      }
    });

    const instagramId = igRes.data.instagram_business_account?.id;
    if (!instagramId) throw new Error('No IG Business Account connected to Page');

    // Get profile
    const profileRes = await axios.get(`https://graph.facebook.com/v19.0/${instagramId}`, {
      params: {
        fields: 'username,profile_picture_url',
        access_token: pageAccessToken
      }
    });

    const username = profileRes.data.username;
    const profilePic = profileRes.data.profile_picture_url;

    const userData = {
      access_token: pageAccessToken,
      username,
      profile_pic: profilePic,
      instagram_id: instagramId,
      page_id: pageId,
      code,
      last_login: new Date()
    };

    users.set(instagramId, userData);
    res.redirect(`/dashboard.html?user_id=${instagramId}`);
  } catch (err) {
    console.error('🔥 Auth error:', serializeError(err));
    res.redirect(`/?error=auth_failed&message=${encodeURIComponent(err.message || 'Login failed')}`);
  }
});

// Send Manual DM
app.post('/send-manual-message', async (req, res) => {
  try {
    const { userId, username, message } = req.body;
    const user = users.get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    await axios.post(`https://graph.facebook.com/v19.0/${user.instagram_id}/messages`, {
      recipient: { username },
      message: { text: message }
    }, {
      headers: {
        Authorization: `Bearer ${user.access_token}`,
        'Content-Type': 'application/json',
        'X-IG-App-ID': INSTAGRAM_APP_ID
      }
    });

    res.json({ success: true });
  } catch (err) {
    console.error('🔥 DM error:', serializeError(err));
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Posts
app.get('/user-posts', async (req, res) => {
  try {
    const user = users.get(req.query.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const postRes = await axios.get(`https://graph.instagram.com/me/media`, {
      params: {
        fields: 'id,caption,media_type,media_url,thumbnail_url',
        access_token: user.access_token
      }
    });

    const posts = postRes.data.data.map(post => ({
      id: post.id,
      caption: post.caption || '',
      media_url: post.media_type === 'VIDEO' ? (post.thumbnail_url || '') : post.media_url,
      media_type: post.media_type
    }));

    res.json(posts);
  } catch (err) {
    console.error('🔥 Posts error:', serializeError(err));
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// Comments
app.get('/post-comments', async (req, res) => {
  try {
    const { userId, postId } = req.query;
    const user = users.get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const resComments = await axios.get(`https://graph.facebook.com/v19.0/${postId}/comments`, {
      params: {
        fields: 'id,text,username,timestamp',
        access_token: user.access_token
      }
    });

    res.json(resComments.data.data || []);
  } catch (err) {
    console.error('🔥 Comments error:', serializeError(err));
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// Save automation config
app.post('/configure', (req, res) => {
  const { userId, postId, keyword, response } = req.body;
  if (!userId || !postId || !keyword || !response)
    return res.status(400).json({ error: 'Missing required fields' });

  configurations.set(userId, { postId, keyword, response });
  res.json({ success: true });
});

// Webhook Verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    return res.status(200).send(challenge);
  }

  console.error('❌ Webhook failed');
  res.sendStatus(403);
});

// Webhook Receiver
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry || [];
    for (const event of entry) {
      const commentData = event.changes?.[0]?.value;
      const media_id = commentData.media_id;
      const text = commentData.text;
      const username = commentData.username;

      for (const [userId, config] of configurations.entries()) {
        if (config.postId !== media_id) continue;
        if (!text.toLowerCase().includes(config.keyword.toLowerCase())) continue;

        const user = users.get(userId);
        if (!user) continue;

        const msg = config.response.replace(/{username}/g, username);
        await axios.post(`https://graph.facebook.com/v19.0/${user.instagram_id}/messages`, {
          recipient: { username },
          message: { text: msg }
        }, {
          headers: {
            Authorization: `Bearer ${user.access_token}`,
            'Content-Type': 'application/json'
          }
        });

        console.log(`✅ Auto-sent to ${username} on match`);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('🔥 Webhook handler error:', serializeError(err));
    res.status(500).json({ error: 'Webhook error' });
  }
});

// User Info
app.get('/user-info', (req, res) => {
  const user = users.get(req.query.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  res.json({
    username: user.username,
    instagram_id: user.instagram_id,
    profile_pic: user.profile_pic
  });
});

// Static routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/dashboard.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Start
app.listen(port, () => {
  console.log('🚀 Server running on port', port);
});
