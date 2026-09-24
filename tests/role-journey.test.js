const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'role-journey-secret';

// In-memory collections for end-to-end multi-role testing
const collections = {
  users: new Map(),
  providers: new Map(),
  bookings: new Map(),
  reviews: new Map(),
  verification_requests: new Map(),
  reports: new Map(),
  payments: new Map(),
  activity_logs: [],
  notifications: [],
  services: new Map(),
  settings: new Map(),
};

function createMockCollection(name) {
  return {
    findOne: async (query) => {
      const map = collections[name];
      if (!map) return null;
      if (query.email?.$regex) {
        const regex = new RegExp(query.email.$regex, query.email.$options || 'i');
        for (const u of map.values()) {
          if (regex.test(u.email)) return { ...u };
        }
        return null;
      }
      if (query.email) return map.get(query.email.toLowerCase()) || null;
      if (query._id) return map.get(String(query._id)) || null;
      if (query.userId) {
        for (const v of map.values()) {
          if (String(v.userId) === String(query.userId)) return { ...v };
        }
        return null;
      }
      if (query.key) return map.get(query.key) || null;
      return Array.from(map.values())[0] || null;
    },
    find: (query = {}) => {
      const map = collections[name] || new Map();
      let arr = Array.isArray(map) ? [...map] : Array.from(map.values());
      return {
        sort: () => ({
          limit: (n) => ({
            toArray: async () => arr.slice(0, n),
          }),
          toArray: async () => arr,
          skip: () => ({
            limit: (n) => ({
              toArray: async () => arr.slice(0, n),
            }),
          }),
        }),
        toArray: async () => arr,
        countDocuments: async () => arr.length,
      };
    },
    countDocuments: async (query = {}) => {
      const map = collections[name];
      if (!map) return 0;
      return Array.isArray(map) ? map.length : map.size;
    },
    insertOne: async (doc) => {
      const id = new ObjectId();
      const inserted = { _id: id, ...doc, createdAt: doc.createdAt || new Date() };
      if (Array.isArray(collections[name])) {
        collections[name].unshift(inserted);
      } else {
        collections[name].set(String(id), inserted);
        if (doc.email) collections[name].set(doc.email.toLowerCase(), inserted);
      }
      return { insertedId: id };
    },
    updateOne: async (query, update) => {
      const map = collections[name];
      if (!map) return { modifiedCount: 0 };
      const item = map.get(String(query._id)) || (query.key ? map.get(query.key) : null);
      if (item && update.$set) {
        Object.assign(item, update.$set);
        return { modifiedCount: 1 };
      }
      return { modifiedCount: 0 };
    },
  };
}

const mockDb = {
  collection: (name) => createMockCollection(name),
};

const dbModule = require('../db');
dbModule.getDb = () => mockDb;

const app = express();
app.use(express.json());
app.use('/api/auth', require('../routes/auth'));
app.use('/api/dashboard', require('../routes/dashboard'));
app.use('/api/admin', require('../routes/admin'));
app.use('/api/bookings', require('../routes/bookings'));

async function apiCall(method, url, token = null, body = null) {
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    return { status: res.status, data };
  } finally {
    server.close();
  }
}

test('Complete Role Ecosystem: Client, Provider, and Admin', async (t) => {
  let clientToken, providerToken, adminToken;
  let clientId, providerId, bookingId;

  await t.test('1. Client Registration & Login', async () => {
    const reg = await apiCall('POST', '/api/auth/register', null, {
      firstName: 'Tendai',
      lastName: 'Moyo',
      email: 'tendai.client@trustconnect.zw',
      password: 'clientPassword123',
      userType: 'client',
    });
    assert.equal(reg.status, 201);
    assert.ok(reg.data.token);
    clientToken = reg.data.token;
    clientId = reg.data.user.id;
  });

  await t.test('2. Provider Registration & Login', async () => {
    const reg = await apiCall('POST', '/api/auth/register', null, {
      firstName: 'Farai',
      lastName: 'Electrician',
      email: 'farai.provider@trustconnect.zw',
      password: 'providerPassword123',
      userType: 'provider',
    });
    assert.equal(reg.status, 201);
    assert.ok(reg.data.token);
    providerToken = reg.data.token;
    providerId = reg.data.user.id;

    // Add provider profile
    collections.providers.set(String(providerId), {
      _id: new ObjectId(providerId),
      userId: new ObjectId(providerId),
      businessName: "Farai's Pro Electrical",
      specialty: 'Electrician',
      rating: 5.0,
      verificationStatus: 'Verified',
      isAvailable: true,
    });
    providerToken = jwt.sign(
      { id: providerId, email: 'farai.provider@trustconnect.zw', userType: 'provider', providerId, fullName: 'Farai Electrician' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
  });

  await t.test('3. Admin Account Setup & Verification', async () => {
    // Seed an admin user with valid ObjectId
    const adminObjectId = new ObjectId();
    const adminId = String(adminObjectId);
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash('adminSecure2026!', salt);

    const adminUser = {
      _id: adminObjectId,
      firstName: 'System',
      lastName: 'Administrator',
      fullName: 'System Administrator',
      email: 'admin@trustconnect.zw',
      password: hashedPassword,
      userType: 'admin',
      active: true,
      createdAt: new Date(),
    };
    collections.users.set(adminId, adminUser);
    collections.users.set('admin@trustconnect.zw', adminUser);

    const loginRes = await apiCall('POST', '/api/auth/login', null, {
      email: 'admin@trustconnect.zw',
      password: 'adminSecure2026!',
    });
    assert.equal(loginRes.status, 200);
    assert.equal(loginRes.data.user.userType, 'admin');
    adminToken = loginRes.data.token;
  });

  await t.test('4. Client creates a booking for the Provider', async () => {
    const bookRes = await apiCall('POST', '/api/bookings', clientToken, {
      service: 'Electrical Repair',
      providerId: providerId,
      providerName: "Farai's Pro Electrical",
      date: '2026-10-01',
      time: '10:00 AM',
      location: '123 Samora Machel Ave, Harare',
      description: 'Fix main breaker tripping',
      amount: 150,
    });
    assert.equal(bookRes.status, 201);
    bookingId = bookRes.data.booking.bookingId;
    assert.ok(bookingId);

    const created = collections.activity_logs.find((item) => item.action === 'booking_created');
    assert.equal(created.details.bookingId, bookingId);
    assert.equal(created.role, 'client');
  });

  await t.test('5. Provider completes the booking and actions are recorded', async () => {
    for (const status of ['Accepted', 'In Progress', 'Completed']) {
      const response = await apiCall('PATCH', `/api/bookings/${bookingId}/status`, providerToken, { status });
      assert.equal(response.status, 200);
    }

    const bookingEvents = collections.activity_logs.filter((item) => item.details?.bookingId === bookingId);
    assert.deepEqual(
      bookingEvents.filter((item) => item.details.status).map((item) => item.details.status),
      ['Completed', 'In Progress', 'Accepted']
    );
    assert.ok(bookingEvents.filter((item) => item.role === 'provider').length >= 3);
  });

  await t.test('6. Admin views the exact audit trail and non-admins are forbidden', async () => {
    const adminDash = await apiCall('GET', '/api/dashboard', adminToken);
    assert.equal(adminDash.status, 200);
    assert.equal(adminDash.data.role, 'admin');
    assert.ok(adminDash.data.stats);
    assert.ok(adminDash.data.stats.users >= 2, 'Admin sees registered users count');
    assert.ok(adminDash.data.stats.bookings >= 1, 'Admin sees created bookings');

    // Admin inspects recent activity log
    assert.ok(Array.isArray(adminDash.data.recentActivity), 'Admin has activity stream');

    const audit = await apiCall('GET', `/api/admin/activity?q=${bookingId}`, adminToken);
    assert.equal(audit.status, 200);
    assert.ok(audit.data.activity.some((item) => item.action === 'booking_created'));
    assert.ok(audit.data.activity.some((item) => item.action === 'booking_completed'));

    const forbidden = await apiCall('GET', '/api/admin/activity', clientToken);
    assert.equal(forbidden.status, 403);
  });

  await t.test('7. Admin inspects and manages users via Admin API', async () => {
    const usersRes = await apiCall('GET', '/api/admin/users', adminToken);
    assert.equal(usersRes.status, 200);
    assert.ok(usersRes.data.users.length >= 3, 'Admin sees all clients, providers, and admins');
    
    const clientFound = usersRes.data.users.find(u => u.email === 'tendai.client@trustconnect.zw');
    const providerFound = usersRes.data.users.find(u => u.email === 'farai.provider@trustconnect.zw');
    assert.ok(clientFound, 'Admin finds the client');
    assert.ok(providerFound, 'Admin finds the provider');
  });
});
