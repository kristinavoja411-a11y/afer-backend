const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const cloudinary = require('cloudinary').v2;
const { randomUUID } = require('crypto');
const { User, Req, Match, PendingVerification, PollToken } = require('./models');

const app = express();

// ---- Security headers ----
app.use(helmet());

// ---- CORS ----
// Set ALLOWED_ORIGINS in Render (comma-separated, e.g. "https://norviondigital.com,https://glance.app")
// to lock this down. A React Native app doesn't send an Origin header, so this
// only matters for browser clients (e.g. the Lovable web build) hitting this API.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (allowedOrigins.length === 0) {
  console.warn('WARNING: ALLOWED_ORIGINS not set — CORS is open to any origin. Set it in Render → Environment once you know your web domain(s).');
}
app.use(cors(allowedOrigins.length ? { origin: allowedOrigins } : {}));

app.use(express.json({ limit: '12mb' }));

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) console.warn('WARNING: JWT_SECRET is not set. Set it in Render → Environment.');
if (!process.env.MONGODB_URI) console.warn('WARNING: MONGODB_URI is not set. Set it in Render → Environment.');
if (!process.env.CLOUDINARY_CLOUD_NAME) console.warn('WARNING: CLOUDINARY_CLOUD_NAME is not set. Photo uploads will fail until Cloudinary env vars are set.');

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch((e) => console.error('MongoDB connection failed:', e.message));

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ---- Abuse protection: rate limiting ----
const generalLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
const emailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'rate_limited' },
});
const photoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false,
  message: { error: 'rate_limited' },
});
app.use('/api/', generalLimiter);
app.use('/api/auth/register-pending', emailLimiter);
app.use('/api/settings/change-email', emailLimiter);
app.use('/api/photos/upload', photoLimiter);

// ---- Email (Gmail SMTP via App Password) ----
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
});

async function sendVerificationEmail(email, verifyUrl) {
  await transporter.sendMail({
    from: `"Glance" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: 'Verify your Glance account',
    text: `Tap this link to verify your Glance account: ${verifyUrl} (expires in 15 minutes)`,
    html: `
      <div style="font-family:sans-serif;text-align:center;padding:24px">
        <h2 style="color:#FF007A">Glance</h2>
        <p>Tap the button below to verify your account.</p>
        <a href="${verifyUrl}" style="display:inline-block;background:#FF007A;color:#fff;text-decoration:none;padding:14px 28px;border-radius:12px;font-weight:bold;margin:16px 0">Verify my account</a>
        <p style="color:#8A5A63;font-size:13px">This link expires in 15 minutes. If you didn't request this, ignore this email.</p>
      </div>`,
  });
}

async function sendEmailChangeVerification(email, verifyUrl) {
  await transporter.sendMail({
    from: `"Glance" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: 'Confirm your new email for Glance',
    text: `Tap this link to confirm this is your new Glance email: ${verifyUrl} (expires in 15 minutes)`,
    html: `
      <div style="font-family:sans-serif;text-align:center;padding:24px">
        <h2 style="color:#FF007A">Glance</h2>
        <p>Tap the button below to confirm this as your new email address.</p>
        <a href="${verifyUrl}" style="display:inline-block;background:#FF007A;color:#fff;text-decoration:none;padding:14px 28px;border-radius:12px;font-weight:bold;margin:16px 0">Confirm new email</a>
        <p style="color:#8A5A63;font-size:13px">This link expires in 15 minutes. If you didn't request this, ignore this email — your account is safe.</p>
      </div>`,
  });
}

const VERIFY_TTL_MS = 15 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const DAILY_FREE_REQUESTS = 5;
const ONLINE_WINDOW_MS = 10 * 60 * 1000;
const MAX_PHOTOS = 6;
const NEARBY_RADIUS_METERS = 300_000; // 300km — covers a whole small country in one query
const CLOSE_RANGE_METERS = 500; // same venue / same block — see note on /api/location below

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function cleanName(name) {
  return typeof name === 'string' ? name.trim().slice(0, 40) : '';
}
function cleanBio(bio) {
  return typeof bio === 'string' ? bio.trim().slice(0, 300) : '';
}
function cleanCaption(caption) {
  return typeof caption === 'string' ? caption.trim().slice(0, 80) : '';
}
// Fires once, the moment bio + 3+ photos are both in place — whichever save gets there last.
function maybeFlagProfileComplete(user) {
  if (!user.profileCompletionNotified && user.bio && user.photos.length >= 3) {
    user.profileCompletionNotified = true;
    sendPush(user._id.toString(), '😉 Looking good', "Profile looking sharp — you're about to turn some heads.");
  }
}
function cleanAge(age) {
  const n = Number(age);
  return Number.isInteger(n) && n >= 18 && n <= 100 ? n : null;
}
function cleanGender(gender) {
  return gender === 'male' || gender === 'female' ? gender : null;
}
// Prevents NoSQL-injection style payloads (e.g. objects/operators) being
// passed in anywhere a MongoDB ObjectId is expected.
function isValidObjectId(id) {
  return typeof id === 'string' && mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === id;
}
function cleanInterestedIn(arr) {
  if (!Array.isArray(arr)) return null;
  const valid = arr.filter((g) => g === 'male' || g === 'female');
  const unique = [...new Set(valid)];
  return unique.length ? unique : null;
}
function bucketFor(meters, hideExact) {
  if (meters <= 15) return { tier: 'very_close', label: '🔥 Right here, next to you' };
  if (meters <= 50) return { tier: 'close', label: '👀 Someone nearby is looking your way' };
  if (meters <= 500) return { tier: 'zone', label: '✨ Somewhere close by' };
  if (hideExact) return { tier: 'far', label: '📍 A bit further away' };
  const km = (meters / 1000).toFixed(1);
  return { tier: 'far', label: `📍 ${km} km away` };
}
async function sendPush(userId, title, body) {
  const user = await User.findById(userId).select('pushToken notificationsEnabled');
  if (!user?.pushToken || user.notificationsEnabled === false) return;
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: user.pushToken, title, body, sound: 'default' }),
    });
  } catch (e) {
    console.log('Push failed (not critical, polling covers it):', e.message);
  }
}
function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const exists = await User.exists({ _id: payload.userId });
    if (!exists) return res.status(401).json({ error: 'unauthorized' });
    req.userId = payload.userId;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'unauthorized' });
  }
}

// ================= AUTH (email magic link) =================

app.post('/api/auth/register-pending', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) return res.status(400).json({ error: 'invalid_email' });

  const name = cleanName(req.body.name);
  const age = cleanAge(req.body.age);
  const gender = cleanGender(req.body.gender);
  const isReturning = await User.exists({ email });
  if (!isReturning && (!name || !age || !gender)) {
    return res.status(400).json({ error: 'missing_profile_fields' });
  }

  const cooldownDoc = await PendingVerification.findOne({ email }).sort({ _id: -1 });
  if (cooldownDoc && cooldownDoc.expiresAt.getTime() - VERIFY_TTL_MS + RESEND_COOLDOWN_MS > Date.now()) {
    return res.status(429).json({ error: 'too_soon' });
  }

  const verifyToken = randomUUID();
  const pollToken = randomUUID();
  const expiresAt = new Date(Date.now() + VERIFY_TTL_MS);

  await PendingVerification.create({ verifyToken, email, name, age, gender, expiresAt });
  await PollToken.create({ pollToken, email, expiresAt });

  const verifyUrl = `${req.protocol}://${req.get('host')}/api/auth/verify?token=${verifyToken}`;

  try {
    await sendVerificationEmail(email, verifyUrl);
    res.json({ ok: true, pollToken });
  } catch (e) {
    console.log('Email send failed:', e.message);
    res.status(500).json({ error: 'email_send_failed' });
  }
});

app.get('/api/auth/verify', async (req, res) => {
  const { token } = req.query;
  const pending = await PendingVerification.findOneAndDelete({ verifyToken: token });
  const page = (title, message, ok) => res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px 24px;background:#FFF6F2">
      <h1 style="color:${ok ? '#FF007A' : '#D64545'}">${title}</h1>
      <p style="color:#3B1A2B;font-size:16px">${message}</p>
    </body></html>`);

  if (!pending) return page('Link not valid', 'This link was already used or is invalid. Go back to the app and request a new one.', false);
  if (pending.expiresAt < new Date()) {
    return page('Link expired', 'This link expired. Go back to the app and request a new one.', false);
  }

  const existing = await User.findOne({ email: pending.email });
  if (!existing) {
    await User.create({
      email: pending.email, name: pending.name, age: pending.age, gender: pending.gender,
      lastResetDay: todayKey(),
    });
  }
  page("You're verified! ✓", 'You can close this tab and go back to the Glance app.', true);
});

app.get('/api/auth/status', async (req, res) => {
  const { pollToken } = req.query;
  const entry = await PollToken.findOne({ pollToken });
  if (!entry) return res.status(400).json({ error: 'invalid_poll_token' });
  if (entry.expiresAt < new Date()) {
    await entry.deleteOne();
    return res.status(400).json({ error: 'expired' });
  }

  const user = await User.findOne({ email: entry.email });
  if (!user) return res.json({ verified: false });

  await entry.deleteOne();
  const authToken = signToken(user._id.toString());
  res.json({
    verified: true, authToken, userId: user._id.toString(), email: user.email,
    name: user.name, age: user.age, gender: user.gender, bio: user.bio, photos: user.photos,
    notificationsEnabled: user.notificationsEnabled,
    preferences: user.preferences, privacy: user.privacy,
    isVerified: !!user.verification?.verified,
  });
});

// ================= PROTECTED ROUTES =================

app.patch('/api/profile', requireAuth, async (req, res) => {
  const user = await User.findById(req.userId);
  // Note: photos are NOT editable here — they only ever change via
  // POST /api/photos/upload and DELETE /api/photos/:index, so every photo
  // goes through Cloudinary (size/format checked, resized, hosted properly).
  const { name, age, bio, notificationsEnabled } = req.body;
  if (name !== undefined) { const n = cleanName(name); if (n) user.name = n; }
  if (age !== undefined) { const a = cleanAge(age); if (a) user.age = a; }
  if (bio !== undefined) user.bio = cleanBio(bio);
  if (typeof notificationsEnabled === 'boolean') user.notificationsEnabled = notificationsEnabled;
  maybeFlagProfileComplete(user);
  await user.save();
  res.json({
    ok: true, name: user.name, age: user.age, bio: user.bio, photos: user.photos,
    notificationsEnabled: user.notificationsEnabled,
  });
});

// ---- Photos (Cloudinary) ----

app.post('/api/photos/upload', requireAuth, async (req, res) => {
  const { photo, caption } = req.body; // photo: data URI, e.g. "data:image/jpeg;base64,...."
  if (typeof photo !== 'string' || !photo.startsWith('data:image/')) {
    return res.status(400).json({ error: 'invalid_photo' });
  }

  const user = await User.findById(req.userId);
  if (user.photos.length >= MAX_PHOTOS) {
    return res.status(400).json({ error: 'max_photos_reached', limit: MAX_PHOTOS });
  }

  try {
    const result = await cloudinary.uploader.upload(photo, {
      folder: 'glance/profile-photos',
      transformation: [{ width: 1200, height: 1200, crop: 'limit' }, { quality: 'auto' }],
    });
    user.photos.push({ url: result.secure_url, publicId: result.public_id, caption: cleanCaption(caption) });
    maybeFlagProfileComplete(user);
    await user.save();
    res.json({ ok: true, photos: user.photos });
  } catch (e) {
    console.log('Cloudinary upload failed:', e.message);
    res.status(500).json({ error: 'upload_failed' });
  }
});

app.patch('/api/photos/:index/caption', requireAuth, async (req, res) => {
  const index = Number(req.params.index);
  const user = await User.findById(req.userId);
  if (!Number.isInteger(index) || index < 0 || index >= user.photos.length) {
    return res.status(400).json({ error: 'invalid_index' });
  }
  user.photos[index].caption = cleanCaption(req.body.caption);
  await user.save();
  res.json({ ok: true, photos: user.photos });
});

app.delete('/api/photos/:index', requireAuth, async (req, res) => {
  const index = Number(req.params.index);
  const user = await User.findById(req.userId);
  if (!Number.isInteger(index) || index < 0 || index >= user.photos.length) {
    return res.status(400).json({ error: 'invalid_index' });
  }

  const [removed] = user.photos.splice(index, 1);
  await user.save();

  if (removed?.publicId) {
    try { await cloudinary.uploader.destroy(removed.publicId); }
    catch (e) { console.log('Cloudinary destroy failed (non-fatal):', e.message); }
  }

  res.json({ ok: true, photos: user.photos });
});

// ---- "Verified" badge: a live in-app camera selfie, not a gallery photo ----
// Doesn't count toward the 6-photo limit and isn't shown as a regular photo —
// it only flips `isVerified` to true so nearby people can see the badge.
// The client is responsible for forcing the *front camera*, in-app only
// (no gallery picker) when capturing this, so it's genuinely a "right now, really you" signal.

app.post('/api/verification/selfie', requireAuth, async (req, res) => {
  const { photo } = req.body;
  if (typeof photo !== 'string' || !photo.startsWith('data:image/')) {
    return res.status(400).json({ error: 'invalid_photo' });
  }

  const user = await User.findById(req.userId);
  const oldPublicId = user.verification?.selfiePublicId;
  const justVerified = !user.verification?.verified;

  try {
    const result = await cloudinary.uploader.upload(photo, {
      folder: 'glance/verification-selfies',
      transformation: [{ width: 800, height: 800, crop: 'limit' }, { quality: 'auto' }],
    });
    user.verification = {
      verified: true, selfieUrl: result.secure_url, selfiePublicId: result.public_id, verifiedAt: new Date(),
    };
    await user.save();
    if (oldPublicId) {
      try { await cloudinary.uploader.destroy(oldPublicId); } catch (e) { /* non-fatal */ }
    }
    if (justVerified) {
      sendPush(req.userId, "😉 You're in", "That smile's going to open some doors around here.");
    }
    res.json({ ok: true, isVerified: true });
  } catch (e) {
    console.log('Verification selfie upload failed:', e.message);
    res.status(500).json({ error: 'upload_failed' });
  }
});

// ---- Discovery preferences & privacy ----

app.patch('/api/preferences', requireAuth, async (req, res) => {
  const user = await User.findById(req.userId);
  const { minAge, maxAge, interestedIn, hideExactDistance } = req.body;

  let nextMin = user.preferences.minAge;
  let nextMax = user.preferences.maxAge;
  if (minAge !== undefined) { const a = cleanAge(minAge); if (a) nextMin = a; }
  if (maxAge !== undefined) { const a = cleanAge(maxAge); if (a) nextMax = a; }
  if (nextMin > nextMax) [nextMin, nextMax] = [nextMax, nextMin]; // swap instead of rejecting
  user.preferences.minAge = nextMin;
  user.preferences.maxAge = nextMax;

  if (interestedIn !== undefined) {
    const cleaned = cleanInterestedIn(interestedIn);
    if (cleaned) user.preferences.interestedIn = cleaned;
  }
  if (typeof hideExactDistance === 'boolean') user.privacy.hideExactDistance = hideExactDistance;

  await user.save();
  res.json({ ok: true, preferences: user.preferences, privacy: user.privacy });
});

// ---- Change email ----

app.post('/api/settings/change-email', requireAuth, async (req, res) => {
  const newEmail = (req.body.newEmail || '').trim().toLowerCase();
  if (!isValidEmail(newEmail)) return res.status(400).json({ error: 'invalid_email' });

  const taken = await User.exists({ email: newEmail });
  if (taken) return res.status(409).json({ error: 'email_in_use' });

  const token = randomUUID();
  await User.findByIdAndUpdate(req.userId, {
    pendingEmailChange: { newEmail, token, expiresAt: new Date(Date.now() + VERIFY_TTL_MS) },
  });

  const verifyUrl = `${req.protocol}://${req.get('host')}/api/settings/verify-email-change?token=${token}`;
  try {
    await sendEmailChangeVerification(newEmail, verifyUrl);
    res.json({ ok: true });
  } catch (e) {
    console.log('Email-change email failed:', e.message);
    res.status(500).json({ error: 'email_send_failed' });
  }
});

app.get('/api/settings/verify-email-change', async (req, res) => {
  const { token } = req.query;
  const page = (title, message, ok) => res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px 24px;background:#FFF6F2">
      <h1 style="color:${ok ? '#FF007A' : '#D64545'}">${title}</h1>
      <p style="color:#3B1A2B;font-size:16px">${message}</p>
    </body></html>`);

  const user = await User.findOne({ 'pendingEmailChange.token': token });
  if (!user) return page('Link not valid', 'This link was already used or is invalid.', false);
  if (user.pendingEmailChange.expiresAt < new Date()) {
    return page('Link expired', 'This link expired. Go back to the app and request the change again.', false);
  }

  const stillFree = !(await User.exists({ email: user.pendingEmailChange.newEmail, _id: { $ne: user._id } }));
  if (!stillFree) {
    user.pendingEmailChange = { newEmail: null, token: null, expiresAt: null };
    await user.save();
    return page('Email taken', 'That email was taken by another account in the meantime.', false);
  }

  user.email = user.pendingEmailChange.newEmail;
  user.pendingEmailChange = { newEmail: null, token: null, expiresAt: null };
  await user.save();
  page('Email updated ✓', 'Your Glance account now uses this email. You can close this tab.', true);
});

app.get('/api/blocked', requireAuth, async (req, res) => {
  const me = await User.findById(req.userId).populate('blocked', 'name photos');
  const blocked = (me.blocked || []).map((u) => ({ id: u._id.toString(), name: u.name, photo: u.photos?.[0]?.url || null }));
  res.json({ blocked });
});

app.post('/api/unblock', requireAuth, async (req, res) => {
  if (!isValidObjectId(req.body.targetUserId)) return res.status(400).json({ error: 'invalid_target' });
  await User.findByIdAndUpdate(req.userId, { $pull: { blocked: req.body.targetUserId } });
  res.json({ ok: true });
});

app.delete('/api/account', requireAuth, async (req, res) => {
  const user = await User.findById(req.userId);
  // Best-effort cleanup of Cloudinary assets so we don't pay to store orphaned photos.
  for (const p of user.photos || []) {
    try { await cloudinary.uploader.destroy(p.publicId); } catch (e) { /* non-fatal */ }
  }
  if (user.verification?.selfiePublicId) {
    try { await cloudinary.uploader.destroy(user.verification.selfiePublicId); } catch (e) { /* non-fatal */ }
  }
  await Req.deleteMany({ $or: [{ from: req.userId }, { to: req.userId }] });
  await Match.deleteMany({ $or: [{ userA: req.userId }, { userB: req.userId }] });
  await User.updateMany({ blocked: req.userId }, { $pull: { blocked: req.userId } });
  await User.findByIdAndDelete(req.userId);
  res.json({ ok: true });
});

app.post('/api/location', requireAuth, async (req, res) => {
  const { lat, lng } = req.body;
  if (typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)
    || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'invalid_coordinates' });
  }

  await User.findByIdAndUpdate(req.userId, {
    location: { type: 'Point', coordinates: [lng, lat] },
    lastSeen: new Date(),
  });

  const me = await User.findById(req.userId).select('blocked gender age preferences privacy');
  const myInterestedIn = me.preferences?.interestedIn?.length ? me.preferences.interestedIn : ['male', 'female'];
  const myMinAge = me.preferences?.minAge ?? 18;
  const myMaxAge = me.preferences?.maxAge ?? 100;

  // NOTE on the split below: gender preference always applies (mutually) —
  // a man should always see women and a woman should always see men,
  // regardless of distance. Age preference is the one that relaxes up
  // close: within CLOSE_RANGE_METERS (same venue / same block), Glance's
  // whole point is that trust — "is this really them, right now" — comes
  // from actually being in the same room, so age range doesn't gate that.
  // Beyond that distance, both age and gender preferences apply, mutually.
  const results = await User.aggregate([
    {
      $geoNear: {
        near: { type: 'Point', coordinates: [lng, lat] },
        distanceField: 'distanceMeters',
        spherical: true,
        maxDistance: NEARBY_RADIUS_METERS,
        query: {
          _id: { $ne: new mongoose.Types.ObjectId(req.userId) },
          lastSeen: { $gte: new Date(Date.now() - ONLINE_WINDOW_MS) },
        },
      },
    },
    { $limit: 150 },
  ]);

  const blockedSet = new Set((me.blocked || []).map((id) => id.toString()));
  const hideExact = !!me.privacy?.hideExactDistance;

  const nearby = results
    .filter((u) => !blockedSet.has(u._id.toString()) && !(u.blocked || []).some((id) => id.toString() === req.userId))
    .filter((u) => {
      const theirInterestedIn = u.preferences?.interestedIn?.length ? u.preferences.interestedIn : ['male', 'female'];
      const iWantThem = myInterestedIn.includes(u.gender);
      const theyWantMe = theirInterestedIn.includes(me.gender);
      if (!iWantThem || !theyWantMe) return false; // gender: always filtered, close or far

      const isFar = u.distanceMeters > CLOSE_RANGE_METERS;
      if (!isFar) return true; // close range: age doesn't gate it

      const theirMin = u.preferences?.minAge ?? 18;
      const theirMax = u.preferences?.maxAge ?? 100;
      const iWantTheirAge = u.age >= myMinAge && u.age <= myMaxAge;
      const theyWantMyAge = me.age >= theirMin && me.age <= theirMax;
      return iWantTheirAge && theyWantMyAge;
    })
    .map((u) => {
      const bucket = bucketFor(u.distanceMeters, hideExact);
      return {
        id: u._id.toString(), name: u.name, age: u.age, gender: u.gender, bio: u.bio,
        photo: u.photos?.[0]?.url || null, tag: bucket.label, tier: bucket.tier,
        isVerified: !!u.verification?.verified,
        ...(hideExact ? {} : { distanceMeters: Math.round(u.distanceMeters) }),
      };
    })
    .slice(0, 50);

  // Light "someone's around" nudge to the OTHER person when they're very close —
  // separate from the "made eyes" request notification, rate-limited so it never spams.
  const NUDGE_COOLDOWN_MS = 2 * 60 * 60 * 1000; // once per 2 hours per person
  for (const u of nearby) {
    if (u.tier !== 'very_close' && u.tier !== 'close') continue;
    const fullUser = await User.findById(u.id).select('pushToken lastNudgedAt notificationsEnabled');
    if (!fullUser?.pushToken || fullUser.notificationsEnabled === false) continue;
    if (fullUser.lastNudgedAt && Date.now() - fullUser.lastNudgedAt.getTime() < NUDGE_COOLDOWN_MS) continue;
    fullUser.lastNudgedAt = new Date();
    fullUser.save();
    sendPush(u.id, '👀 Someone is close by', "Someone nearby just glanced your way — don't keep them waiting.");
  }

  res.json({ nearby });
});

app.post('/api/requests', requireAuth, async (req, res) => {
  const { toUserId } = req.body;
  if (!isValidObjectId(toUserId)) return res.status(400).json({ error: 'invalid_target' });

  const from = await User.findById(req.userId);
  const to = await User.findById(toUserId);
  if (!to) return res.status(404).json({ error: 'user not found' });
  if (from.blocked.includes(toUserId) || to.blocked.includes(req.userId)) {
    return res.status(403).json({ error: 'blocked' });
  }

  const today = todayKey();
  if (from.lastResetDay !== today) { from.lastResetDay = today; from.requestsSentToday = 0; }
  if (from.requestsSentToday >= DAILY_FREE_REQUESTS) {
    return res.status(429).json({ error: 'daily_limit_reached', limit: DAILY_FREE_REQUESTS });
  }

  const request = await Req.create({ from: req.userId, to: toUserId, status: 'pending' });
  from.requestsSentToday += 1;
  await from.save();
  sendPush(toUserId, 'Someone nearby 👀', `${from.name} just made eyes at you.`);
  res.json({ requestId: request._id.toString(), remainingToday: DAILY_FREE_REQUESTS - from.requestsSentToday });
});

app.get('/api/requests/incoming', requireAuth, async (req, res) => {
  const me = await User.findById(req.userId).select('blocked');
  const blockedSet = new Set((me.blocked || []).map((id) => id.toString()));

  const reqs = await Req.find({ to: req.userId, status: 'pending' }).populate('from', 'name age photos blocked');
  const incoming = reqs
    .filter((r) => r.from && !blockedSet.has(r.from._id.toString()) && !(r.from.blocked || []).some((id) => id.toString() === req.userId))
    .map((r) => ({ requestId: r._id.toString(), fromUserId: r.from._id.toString(), name: r.from.name, age: r.from.age, photo: r.from.photos?.[0]?.url || null }));
  res.json({ incoming });
});

app.post('/api/requests/:id/respond', requireAuth, async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ error: 'invalid_request_id' });
  const request = await Req.findById(req.params.id);
  if (!request) return res.status(404).json({ error: 'request not found' });
  if (request.to.toString() !== req.userId) return res.status(403).json({ error: 'forbidden' });

  const { action } = req.body;
  request.status = action === 'accept' ? 'accepted' : 'ignored';
  await request.save();

  if (action === 'accept') {
    const match = await Match.create({ userA: request.from, userB: request.to, messages: [] });
    const toUser = await User.findById(request.to).select('name');
    sendPush(request.from.toString(), "It's a match! 🎉", `${toUser?.name || 'Someone'} can chat with you now.`);
    return res.json({ matched: true, matchId: match._id.toString() });
  }
  res.json({ matched: false });
});

app.post('/api/block', requireAuth, async (req, res) => {
  if (!isValidObjectId(req.body.targetUserId)) return res.status(400).json({ error: 'invalid_target' });
  await User.findByIdAndUpdate(req.userId, { $addToSet: { blocked: req.body.targetUserId } });
  res.json({ ok: true });
});

app.post('/api/report', requireAuth, async (req, res) => {
  const { targetUserId, reason } = req.body;
  if (!isValidObjectId(targetUserId)) return res.status(400).json({ error: 'invalid_target' });
  console.log(`REPORT: ${req.userId} reported ${targetUserId} — reason: ${reason || 'not specified'}`);
  await User.findByIdAndUpdate(req.userId, { $addToSet: { blocked: targetUserId } });
  res.json({ ok: true });
});

app.get('/api/matches', requireAuth, async (req, res) => {
  const myMatches = await Match.find({ $or: [{ userA: req.userId }, { userB: req.userId }] })
    .populate('userA', 'name photos').populate('userB', 'name photos');
  const mine = myMatches.map((m) => {
    const other = m.userA._id.toString() === req.userId ? m.userB : m.userA;
    return { matchId: m._id.toString(), otherUserId: other._id.toString(), name: other.name, photo: other.photos?.[0]?.url || null };
  });
  res.json({ matches: mine });
});

async function requireMatchMember(req, res, next) {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ error: 'invalid_match_id' });
  const match = await Match.findById(req.params.id);
  if (!match) return res.status(404).json({ error: 'match not found' });
  if (match.userA.toString() !== req.userId && match.userB.toString() !== req.userId) {
    return res.status(403).json({ error: 'forbidden' });
  }
  req.match = match;
  next();
}

app.get('/api/matches/:id/messages', requireAuth, requireMatchMember, (req, res) => {
  const messages = req.match.messages.map((m) => ({ id: m._id.toString(), fromUserId: m.fromUserId.toString(), text: m.text, createdAt: m.createdAt.getTime() }));
  res.json({ messages });
});

app.post('/api/matches/:id/messages', requireAuth, requireMatchMember, async (req, res) => {
  const text = typeof req.body.text === 'string' ? req.body.text.trim().slice(0, 1000) : '';
  if (!text) return res.status(400).json({ error: 'empty_message' });

  req.match.messages.push({ fromUserId: req.userId, text });
  await req.match.save();
  const saved = req.match.messages[req.match.messages.length - 1];

  const otherId = req.match.userA.toString() === req.userId ? req.match.userB.toString() : req.match.userA.toString();
  const sender = await User.findById(req.userId).select('name');
  sendPush(otherId, sender?.name || 'New message', text);

  res.json({ message: { id: saved._id.toString(), fromUserId: req.userId, text, createdAt: saved.createdAt.getTime() } });
});

app.post('/api/push-token', requireAuth, async (req, res) => {
  await User.findByIdAndUpdate(req.userId, { pushToken: req.body.token });
  res.json({ ok: true });
});

app.get('/', (req, res) => res.send('Glance API is running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Glance backend running on port ${PORT}`));
