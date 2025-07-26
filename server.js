// === server.js ===
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const qs = require('querystring');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 5000;
const FB_APP_ID = process.env.FB_APP_ID;
const FB_APP_SECRET = process.env.FB_APP_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

let users = []; // In-memory store, replace with DB in production

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Step 1: Redirect to Facebook Login with IG scopes (styled like Instagram login)
app.get('/auth/instagram-login', (req, res) => {
  const scopes = [
    'instagram_basic',
    'instagram_manage_comments',
    'instagram_manage_messages',
    'instagram_manage_insights'
  ].join(',');

  const loginUrl = `https://www.facebook.com/v18.0/dialog/oauth?client_id=${FB_APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}&response_type=code&state=random123`;
  res.redirect(loginUrl);
});

// Step 2: Callback from Facebook with Code
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  try {
    const tokenRes = await axios.get(
      `https://graph.facebook.com/v18.0/oauth/access_token?${qs.stringify({
        client_id: FB_APP_ID,
        client_secret: FB_APP_SECRET,
        redirect_uri: REDIRECT_URI,
        code
      })}`
    );

    const accessToken = tokenRes.data.access_token;
    const userRes = await axios.get(
      `https://graph.facebook.com/v18.0/me/accounts?access_token=${accessToken}`
    );

    const pages = userRes.data.data;

    for (const page of pages) {
      const igRes = await axios.get(
        `https://graph.facebook.com/v18.0/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`
      );
      if (igRes.data.instagram_business_account) {
        users.push({
          user_id: page.id,
          page_access_token: page.access_token,
          ig_id: igRes.data.instagram_business_account.id
        });

        // Subscribe to Webhooks
        await axios.post(
          `https://graph.facebook.com/v18.0/${page.id}/subscribed_apps`,
          { subscribed_fields: ['mention', 'comments', 'messages'] },
          { headers: { Authorization: `Bearer ${page.access_token}` } }
        );
      }
    }

    res.send('✅ IG account connected and webhook subscribed.');
  } catch (err) {
    console.error(err.response?.data || err);
    res.status(500).send('❌ Authentication failed');
  }
});

// Step 3: Webhook verification
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Step 4: Handle comments
app.post('/webhook', async (req, res) => {
  try {
    const data = req.body;
    if (data.object === 'page') {
      for (const entry of data.entry) {
        for (const change of entry.changes) {
          const value = change.value;

          if (value?.item === 'comment' && value?.verb === 'add') {
            const commentText = value.message;
            const igUser = users.find(u => u.user_id === entry.id);

            if (igUser && commentText.includes('demo')) {
              await axios.post(
                `https://graph.facebook.com/v18.0/${igUser.ig_id}/messages`,
                {
                  recipient: { comment_id: value.comment_id },
                  message: { text: 'Hey 👋 Thanks for commenting! Check your inbox!' }
                },
                {
                  headers: {
                    Authorization: `Bearer ${igUser.page_access_token}`
                  }
                }
              );
            }
          }
        }
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook Error:', err.response?.data || err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`🌐 Server running on http://localhost:${PORT}`);
});
