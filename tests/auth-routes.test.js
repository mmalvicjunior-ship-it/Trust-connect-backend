const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Create mock database layer for full route testing
const mockUsers = new Map();

const mockCollection = {
  findOne: async (query) => {
    if (query.email?.$regex) {
      const regex = new RegExp(query.email.$regex, query.email.$options || 'i');
      for (const u of mockUsers.values()) {
        if (regex.test(u.email)) return { ...u };
      }
      return null;
    }
    if (query.email) {
      return mockUsers.get(query.email.toLowerCase()) || null;
    }
    return null;
  },
  insertOne: async (doc) => {
    const id = 'mock-id-' + Math.random().toString(36).substring(2, 9);
    const user = { _id: id, ...doc };
    mockUsers.set(doc.email.toLowerCase(), user);
    return { insertedId: id };
  },
  updateOne: async (query, update) => {
    for (const [email, u] of mockUsers.entries()) {
      if (u._id === query._id) {
        if (update.$set) {
          Object.assign(u, update.$set);
        }
        return { modifiedCount: 1 };
      }
    }
    return { modifiedCount: 0 };
  },
};

const mockDb = {
  collection: (name) => {
    if (name === 'users') return mockCollection;
    return {
      createIndex: async () => {},
      findOne: async () => null,
      insertOne: async () => ({}),
      updateOne: async () => ({}),
    };
  },
};

// Override getDb in require cache
const dbModule = require('../db');
dbModule.getDb = () => mockDb;

const authRoutes = require('../routes/auth');
const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);

// Helper for sending mock requests to Express app
async function mockRequest(method, url, body) {
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return { status: res.status, data };
  } finally {
    server.close();
  }
}

test('Route: Register a new user with bcrypt hash', async () => {
  const res = await mockRequest('POST', '/api/auth/register', {
    firstName: 'Alice',
    lastName: 'Smith',
    email: 'alice@example.com',
    password: 'securePassword123',
    userType: 'client',
  });

  assert.equal(res.status, 201);
  assert.ok(res.data.token, 'Should return a JWT token');
  assert.equal(res.data.user.email, 'alice@example.com');

  // Verify stored password in DB is a bcrypt hash
  const storedUser = mockUsers.get('alice@example.com');
  assert.ok(storedUser.password.startsWith('$2'), 'Password should be bcrypt hashed');
});

test('Route: Login with bcrypt hashed user', async () => {
  const res = await mockRequest('POST', '/api/auth/login', {
    email: 'alice@example.com',
    password: 'securePassword123',
  });

  assert.equal(res.status, 200);
  assert.ok(res.data.token);
  assert.equal(res.data.user.email, 'alice@example.com');
});

test('Route: Login with legacy plain-text user and auto-migrate to bcrypt', async () => {
  // Seed a legacy user with plain-text password
  const legacyEmail = 'legacy.user@example.com';
  const legacyPassword = 'plainTextSecret999';
  mockUsers.set(legacyEmail, {
    _id: 'legacy-user-123',
    firstName: 'Bob',
    lastName: 'Legacy',
    fullName: 'Bob Legacy',
    email: legacyEmail,
    password: legacyPassword, // plain text!
    userType: 'client',
  });

  // Attempt login with the legacy plain-text password
  const res = await mockRequest('POST', '/api/auth/login', {
    email: 'legacy.user@example.com',
    password: legacyPassword,
  });

  assert.equal(res.status, 200, 'Legacy user should successfully log in');
  assert.ok(res.data.token, 'Should return a valid JWT token');
  assert.equal(res.data.user.email, legacyEmail);

  // Check that the password was automatically converted to bcrypt in the database
  const updatedUser = mockUsers.get(legacyEmail);
  assert.notEqual(updatedUser.password, legacyPassword, 'Password must not remain plain text');
  assert.ok(updatedUser.password.startsWith('$2'), 'Password must be converted to bcrypt hash');

  // Second login attempt uses the new bcrypt hash seamlessly
  const secondLogin = await mockRequest('POST', '/api/auth/login', {
    email: 'legacy.user@example.com',
    password: legacyPassword,
  });
  assert.equal(secondLogin.status, 200, 'Second login with migrated bcrypt hash must succeed');
});

test('Route: Login fails on invalid password', async () => {
  const res = await mockRequest('POST', '/api/auth/login', {
    email: 'alice@example.com',
    password: 'WrongPassword!',
  });

  assert.equal(res.status, 401);
  assert.equal(res.data.error, 'Invalid email or password');
});

test('Route: Login fails on non-existent email', async () => {
  const res = await mockRequest('POST', '/api/auth/login', {
    email: 'nonexistent@example.com',
    password: 'password123',
  });

  assert.equal(res.status, 401);
  assert.equal(res.data.error, 'Invalid email or password');
});
