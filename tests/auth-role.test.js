const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'role-test-secret';

const JWT_SECRET = process.env.JWT_SECRET;

// ------- Mock database layer ----------
const mockUsers = new Map();

function makeCollection(name) {
  const docs = name === 'users' ? mockUsers : new Map();
  return {
    findOne: async (query) => {
      if (query.email?.$regex) {
        const regex = new RegExp(query.email.$regex, query.email.$options || 'i');
        for (const u of docs.values()) {
          if (regex.test(u.email)) return { ...u };
        }
        return null;
      }
      if (query.email) {
        return docs.get(String(query.email).toLowerCase()) || null;
      }
      if (query._id) {
        for (const d of docs.values()) {
          if (String(d._id) === String(query._id)) return { ...d };
        }
      }
      return null;
    },
    insertOne: async (doc) => {
      const id = 'mock-id-' + Math.random().toString(36).substring(2, 9);
      const full = { _id: id, ...doc };
      if (name === 'users') docs.set(full.email.toLowerCase(), full);
      return { insertedId: id };
    },
    updateOne: async (query, update) => {
      for (const [key, d] of docs.entries()) {
        if (String(d._id) === String(query._id)) {
          if (update.$set) Object.assign(d, update.$set);
          return { modifiedCount: 1 };
        }
      }
      return { modifiedCount: 0 };
    },
    find: () => {
      const list = [...docs.values()];
      const cursor = {
        sort: () => cursor,
        skip: () => cursor,
        limit: () => cursor,
        toArray: async () => list,
      };
      return cursor;
    },
  };
}

const mockDb = {
  collection: (name) => makeCollection(name),
};

const dbModule = require('../db');
dbModule.getDb = () => mockDb;

const authRoutes = require('../routes/auth');
const adminRoutes = require('../routes/admin');

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);

async function mockRequest(method, url, body, token) {
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return { status: res.status, data };
  } finally {
    server.close();
  }
}

function signToken(userType, id = 'role-test-user') {
  return jwt.sign({ id, email: 'x@example.com', userType, providerId: null }, JWT_SECRET, { expiresIn: '1h' });
}

const password = 'TestPassword123';

async function seedUser(email, userType) {
  const hash = await bcrypt.hash(password, 4);
  mockUsers.set(email.toLowerCase(), {
    _id: email.split('@')[0] + '-id',
    firstName: 'Test',
    lastName: 'User',
    fullName: 'Test User',
    email: email.toLowerCase(),
    password: hash,
    userType,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

test('Route: Client can sign in when selecting role "client"', async () => {
  await seedUser('client.role@example.com', 'client');
  const res = await mockRequest('POST', '/api/auth/login', {
    email: 'client.role@example.com',
    password,
    userType: 'client',
  });
  assert.equal(res.status, 200);
  assert.ok(res.data.token, 'Should return a JWT token');
  assert.equal(res.data.user.userType, 'client');
});

test('Route: Provider can sign in when selecting role "provider"', async () => {
  await seedUser('provider.role@example.com', 'provider');
  const res = await mockRequest('POST', '/api/auth/login', {
    email: 'provider.role@example.com',
    password,
    userType: 'provider',
  });
  assert.equal(res.status, 200);
  assert.ok(res.data.token, 'Should return a JWT token');
  assert.equal(res.data.user.userType, 'provider');
});

test('Route: Admin can sign in when selecting role "admin"', async () => {
  await seedUser('admin.role@example.com', 'admin');
  const res = await mockRequest('POST', '/api/auth/login', {
    email: 'admin.role@example.com',
    password,
    userType: 'admin',
  });
  assert.equal(res.status, 200);
  assert.ok(res.data.token, 'Should return a JWT token');
  assert.equal(res.data.user.userType, 'admin');
});

test('Route: Client is denied when selecting the wrong role "provider"', async () => {
  await seedUser('client.wrongrole@example.com', 'client');
  const res = await mockRequest('POST', '/api/auth/login', {
    email: 'client.wrongrole@example.com',
    password,
    userType: 'provider',
  });
  assert.equal(res.status, 403);
  assert.match(res.data.error, /correct account type/i);
});

test('Route: Client is denied when selecting role "admin"', async () => {
  await seedUser('client.hax0r@example.com', 'client');
  const res = await mockRequest('POST', '/api/auth/login', {
    email: 'client.hax0r@example.com',
    password,
    userType: 'admin',
  });
  assert.equal(res.status, 403);
  assert.match(res.data.error, /correct account type/i);
});

test('Route: Provider is denied when selecting role "client"', async () => {
  await seedUser('provider.wrongrole@example.com', 'provider');
  const res = await mockRequest('POST', '/api/auth/login', {
    email: 'provider.wrongrole@example.com',
    password,
    userType: 'client',
  });
  assert.equal(res.status, 403);
  assert.match(res.data.error, /correct account type/i);
});

test('Route: Invalid role value returns 400', async () => {
  await seedUser('client.invalidrole@example.com', 'client');
  const res = await mockRequest('POST', '/api/auth/login', {
    email: 'client.invalidrole@example.com',
    password,
    userType: 'superuser',
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /client, provider, admin/i);
});

test('Route: Signing in without a role still works (backwards compatible)', async () => {
  await seedUser('client.norole@example.com', 'client');
  const res = await mockRequest('POST', '/api/auth/login', {
    email: 'client.norole@example.com',
    password,
  });
  assert.equal(res.status, 200);
  assert.ok(res.data.token);
});

test('Route: Password still verified before role check', async () => {
  await seedUser('client.badpass@example.com', 'client');
  const res = await mockRequest('POST', '/api/auth/login', {
    email: 'client.badpass@example.com',
    password: 'WrongPassword!',
    userType: 'client',
  });
  assert.equal(res.status, 401);
  assert.equal(res.data.error, 'Invalid email or password');
});

test('Admin: request without a token is rejected with 401', async () => {
  const res = await mockRequest('GET', '/api/admin/activity');
  assert.equal(res.status, 401);
});

test('Admin: client token is denied access with 403', async () => {
  const token = signToken('client');
  const res = await mockRequest('GET', '/api/admin/activity', undefined, token);
  assert.equal(res.status, 403);
});

test('Admin: provider token is denied access with 403', async () => {
  const token = signToken('provider');
  const res = await mockRequest('GET', '/api/admin/activity', undefined, token);
  assert.equal(res.status, 403);
});

test('Admin: admin token is allowed access', async () => {
  const token = signToken('admin', 'admin-access-id');
  const res = await mockRequest('GET', '/api/admin/activity', undefined, token);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.data.activity));
});