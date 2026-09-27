const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true, maxlength: 40 },
  age: { type: Number, required: true, min: 18, max: 100 },
  gender: { type: String, enum: ['male', 'female'], required: true },
  bio: { type: String, default: '', maxlength: 300 },

  // Photos now live on Cloudinary — we only ever store the secure URL + the
  // matching public_id (needed so we can delete the asset from Cloudinary
  // itself when a user removes or replaces a photo). Never accept raw
  // image data into these fields directly from a client request.
  // Photos live on Cloudinary — we only ever store the secure URL, the
  // matching public_id (needed to delete the asset from Cloudinary itself),
  // and an optional caption the user writes for that specific photo.
  // Never accept raw image data into this field directly from a client request.
  photos: {
    type: [{
      url: { type: String, required: true },
      publicId: { type: String, required: true },
      caption: { type: String, default: '', maxlength: 80 },
    }],
    default: [],
  }, // max 6 enforced in route logic

  location: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], default: [0, 0] }, // [lng, lat]
  },
  lastSeen: { type: Date, default: null },
  requestsSentToday: { type: Number, default: 0 },
  lastResetDay: { type: String, default: '' },
  pushToken: { type: String, default: null },
  notificationsEnabled: { type: Boolean, default: true },
  profileCompletionNotified: { type: Boolean, default: false }, // one-time flirty nudge once profile looks complete
  lastNudgedAt: { type: Date, default: null }, // rate-limits the "someone's nearby" nudge push
  blocked: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  // "Verified" badge — a live in-app camera selfie (never from the gallery),
  // separate from the 6 profile photos. Builds trust for the app's core
  // moment: you spot someone nearby and want to know the profile is really
  // them, right now — not an old or borrowed photo.
  verification: {
    verified: { type: Boolean, default: false },
    selfieUrl: { type: String, default: null },
    selfiePublicId: { type: String, default: null },
    verifiedAt: { type: Date, default: null },
  },

  // Discovery preferences — who shows up for me, and who I show up for.
  preferences: {
    interestedIn: { type: [String], enum: ['male', 'female'], default: ['male', 'female'] },
    minAge: { type: Number, default: 18, min: 18, max: 100 },
    maxAge: { type: Number, default: 100, min: 18, max: 100 },
  },

  // Privacy settings
  privacy: {
    hideExactDistance: { type: Boolean, default: false },
  },

  // Pending email-change request (magic-link style, same pattern as signup)
  pendingEmailChange: {
    newEmail: { type: String, default: null },
    token: { type: String, default: null },
    expiresAt: { type: Date, default: null },
  },
}, { timestamps: true });
userSchema.index({ location: '2dsphere' });

const requestSchema = new mongoose.Schema({
  from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['pending', 'accepted', 'ignored'], default: 'pending' },
}, { timestamps: true });

const messageSchema = new mongoose.Schema({
  fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true, maxlength: 1000 },
}, { timestamps: true });

const matchSchema = new mongoose.Schema({
  userA: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userB: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  messages: [messageSchema],
}, { timestamps: true });

// Pending email verifications — auto-deleted by MongoDB once expired (TTL index)
const pendingVerificationSchema = new mongoose.Schema({
  verifyToken: { type: String, required: true, unique: true },
  email: { type: String, required: true },
  name: String,
  age: Number,
  gender: String,
  expiresAt: { type: Date, required: true },
});
pendingVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const pollTokenSchema = new mongoose.Schema({
  pollToken: { type: String, required: true, unique: true },
  email: { type: String, required: true },
  expiresAt: { type: Date, required: true },
});
pollTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = {
  User: mongoose.model('User', userSchema),
  Req: mongoose.model('Req', requestSchema), // named Req to avoid clashing with Express's `req`
  Match: mongoose.model('Match', matchSchema),
  PendingVerification: mongoose.model('PendingVerification', pendingVerificationSchema),
  PollToken: mongoose.model('PollToken', pollTokenSchema),
};
