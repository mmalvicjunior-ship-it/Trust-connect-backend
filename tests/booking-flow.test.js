const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'booking-flow-test-secret';

const JWT_SECRET = process.env.JWT_SECRET;

const CUSTOMER_ID = 'c'.repeat(24);
const CUSTOMER_NAME = 'John Doe';
const PROVIDER_ID = 'a'.repeat(24);
const PROVIDER_NAME = 'Mike Plumbing';
const OTHER_PROVIDER_ID = 'b'.repeat(24);

// ------- Mock database layer ----------
const stores = new Map();

function collectionDocs(name) {
  if (!stores.has(name)) stores.set(name, new Map());
  return stores.get(name);
}

function createId() {
  return 'mock-id-' + Math.random().toString(36).substring(2, 9);
}

function matches(doc, query) {
  for (const [key, expected] of Object.entries(query || {})) {
    if (expected && typeof expected === 'object' && Array.isArray(expected.$in)) {
      if (!expected.$in.some((v) => String(doc[key]) === String(v))) return false;
      continue;
    }
    if (String(doc[key]) !== String(expected)) return false;
  }
  return true;
}

function makeCollection(name) {
  const docs = collectionDocs(name);
  return {
    findOne: async (query) => {
      for (const d of docs.values()) {
        if (matches(d, query)) return { ...d };
      }
      return null;
    },
    find: (query) => {
      const cursor = {
        sort: () => cursor,
        skip: () => cursor,
        limit: () => cursor,
        toArray: async () =>
          [...docs.values()].filter((d) => matches(d, query)).map((d) => ({ ...d })),
      };
      return cursor;
    },
    insertOne: async (doc) => {
      const full = { _id: doc._id || createId(), ...doc };
      docs.set(String(full._id), full);
      return { insertedId: full._id };
    },
    updateOne: async (query, update) => {
      for (const d of docs.values()) {
        if (matches(d, query)) {
          if (update.$set) Object.assign(d, update.$set);
          if (update.$inc) {
            for (const [k, v] of Object.entries(update.$inc)) {
              d[k] = (Number(d[k]) || 0) + v;
            }
          }
          return { modifiedCount: 1 };
        }
      }
      return { modifiedCount: 0 };
    },
    countDocuments: async (query) =>
      [0, ...[...docs.values()].filter((d) => matches(d, query)).map(() => 1)].reduce((a, b) => a + b, 0),
  };
}

const mockDb = {
  collection: (name) => makeCollection(name),
};

const dbModule = require('../db');
dbModule.getDb = () => mockDb;
dbModule.client = null;

const bookingRoutes = require('../routes/bookings');
const adminRoutes = require('../routes/admin');

const app = express();
app.use(express.json());
app.use('/api/bookings', bookingRoutes);
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
    const data = res.status === 204 ? null : await res.json().catch(() => ({}));
    return { status: res.status, data };
  } finally {
    server.close();
  }
}

function signToken(userType, id, providerId, fullName) {
  return jwt.sign(
    { id, email: `${userType}-${id}@example.com`, userType, providerId, fullName },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

const clientToken = signToken('client', CUSTOMER_ID, null, CUSTOMER_NAME);
const providerToken = signToken('provider', 'provuser-1', PROVIDER_ID, PROVIDER_NAME);
const otherProviderToken = signToken('provider', 'provuser-2', OTHER_PROVIDER_ID, 'Other Provider');
const adminToken = signToken('admin', 'admin-sa', null, 'System Admin');

function bookingBody(extra = {}) {
  return {
    providerId: PROVIDER_ID,
    providerName: PROVIDER_NAME,
    service: 'Plumbing Repair',
    date: '2026-10-01',
    time: '10:00',
    location: 'Test Address',
    description: 'Leaking sink',
    amount: 120,
    ...extra,
  };
}

async function seedProvider() {
  await mockDb.collection('providers').insertOne({
    _id: PROVIDER_ID,
    userId: 'provuser-1',
    businessName: 'Mike Plumbing Co',
    specialty: 'Plumbing',
  });
}

test('Lifecycle: client creates a booking with PENDING status', async () => {
  await seedProvider();
  const res = await mockRequest('POST', '/api/bookings', bookingBody(), clientToken);
  assert.equal(res.status, 201);
  assert.equal(res.data.booking.status, 'Pending');
  assert.equal(res.data.booking.customerName, CUSTOMER_NAME);
  assert.equal(res.data.booking.providerId.toString(), PROVIDER_ID);
});

test('Lifecycle: unassigned provider cannot accept a booking (403)', async () => {
  const created = await mockRequest('POST', '/api/bookings', bookingBody(), clientToken);
  const id = created.data.booking.bookingId;
  const res = await mockRequest('PATCH', `/api/bookings/${id}/status`, { status: 'Accepted' }, otherProviderToken);
  assert.equal(res.status, 403);
});

test('Lifecycle: client cannot accept their own booking (403)', async () => {
  const created = await mockRequest('POST', '/api/bookings', bookingBody(), clientToken);
  const id = created.data.booking.bookingId;
  const res = await mockRequest('PATCH', `/api/bookings/${id}/status`, { status: 'Accepted' }, clientToken);
  assert.equal(res.status, 403);
});

test('Lifecycle: provider declines a PENDING booking -> CANCELLED', async () => {
  const created = await mockRequest('POST', '/api/bookings', bookingBody(), clientToken);
  const id = created.data.booking.bookingId;
  const res = await mockRequest('PATCH', `/api/bookings/${id}/status`, { status: 'Cancelled' }, providerToken);
  assert.equal(res.status, 200);
  assert.equal(res.data.status, 'Cancelled');
});

test('Lifecycle: cancelled booking is terminal (further transition rejected)', async () => {
  const created = await mockRequest('POST', '/api/bookings', bookingBody(), clientToken);
  const id = created.data.booking.bookingId;
  await mockRequest('PATCH', `/api/bookings/${id}/status`, { status: 'Cancelled' }, providerToken);
  const res = await mockRequest('PATCH', `/api/bookings/${id}/status`, { status: 'Accepted' }, providerToken);
  assert.equal(res.status, 400);
  assert.match(res.data.error, /Cannot change status/);
});

test('Lifecycle: full happy path PENDING -> ACCEPTED -> IN PROGRESS -> COMPLETED', async () => {
  const created = await mockRequest('POST', '/api/bookings', bookingBody(), clientToken);
  const id = created.data.booking.bookingId;

  const accept = await mockRequest('PATCH', `/api/bookings/${id}/status`, { status: 'Accepted' }, providerToken);
  assert.equal(accept.status, 200);
  assert.equal(accept.data.status, 'Accepted');

  const start = await mockRequest('PATCH', `/api/bookings/${id}/status`, { status: 'In Progress' }, providerToken);
  assert.equal(start.status, 200);
  assert.equal(start.data.status, 'In Progress');

  const done = await mockRequest('PATCH', `/api/bookings/${id}/status`, { status: 'Completed' }, providerToken);
  assert.equal(done.status, 200);
  assert.equal(done.data.status, 'Completed');
});

test('Lifecycle: invalid transition PENDING -> COMPLETED is rejected (400)', async () => {
  const created = await mockRequest('POST', '/api/bookings', bookingBody(), clientToken);
  const id = created.data.booking.bookingId;
  const res = await mockRequest('PATCH', `/api/bookings/${id}/status`, { status: 'Completed' }, providerToken);
  assert.equal(res.status, 400);
  assert.match(res.data.error, /Cannot change status/);
});

test('Lifecycle: legacy statuses "Confirmed"/"Rejected" are invalid (400)', async () => {
  const created = await mockRequest('POST', '/api/bookings', bookingBody(), clientToken);
  const id = created.data.booking.bookingId;
  const rejected = await mockRequest('PATCH', `/api/bookings/${id}/status`, { status: 'Rejected' }, providerToken);
  assert.equal(rejected.status, 400);
  const confirmed = await mockRequest('PATCH', `/api/bookings/${id}/status`, { status: 'Confirmed' }, providerToken);
  assert.equal(confirmed.status, 400);
});

test('Lifecycle: admin can update a booking status', async () => {
  const created = await mockRequest('POST', '/api/bookings', bookingBody(), clientToken);
  const id = created.data.booking.bookingId;
  const res = await mockRequest('PATCH', `/api/bookings/${id}/status`, { status: 'Cancelled' }, adminToken);
  assert.equal(res.status, 200);
  assert.equal(res.data.status, 'Cancelled');
});

test('Provider view: requests vs current vs completed buckets', async () => {
  const b1 = await mockRequest('POST', '/api/bookings', bookingBody(), clientToken);
  await mockRequest('PATCH', `/api/bookings/${b1.data.booking.bookingId}/status`, { status: 'Accepted' }, providerToken);
  await mockRequest('PATCH', `/api/bookings/${b1.data.booking.bookingId}/status`, { status: 'In Progress' }, providerToken);
  const b2 = await mockRequest('POST', '/api/bookings', bookingBody({ providerId: OTHER_PROVIDER_ID, providerName: 'Other Provider' }), clientToken);
  await mockRequest('PATCH', `/api/bookings/${b2.data.booking.bookingId}/status`, { status: 'Cancelled' }, otherProviderToken);
  const b3 = await mockRequest('POST', '/api/bookings', bookingBody(), clientToken);
  await mockRequest('PATCH', `/api/bookings/${b3.data.booking.bookingId}/status`, { status: 'Accepted' }, providerToken);
  await mockRequest('PATCH', `/api/bookings/${b3.data.booking.bookingId}/status`, { status: 'In Progress' }, providerToken);
  await mockRequest('PATCH', `/api/bookings/${b3.data.booking.bookingId}/status`, { status: 'Completed' }, providerToken);

  const res = await mockRequest('GET', '/api/bookings/provider', undefined, providerToken);
  assert.equal(res.status, 200);
  assert.ok(res.data.requests.every((b) => b.status === 'Pending'));
  assert.ok(res.data.current.every((b) => b.status === 'Accepted' || b.status === 'In Progress'));
  assert.ok(res.data.completed.every((b) => b.status === 'Completed'));
});

test('Privacy: client cannot view another provider booking (403)', async () => {
  const created = await mockRequest('POST', '/api/bookings', bookingBody(), clientToken);
  const id = created.data.booking.bookingId;
  const res = await mockRequest('GET', `/api/bookings/${id}`, undefined, otherProviderToken);
  assert.equal(res.status, 403);
});

test('Privacy: admin can view any booking', async () => {
  const created = await mockRequest('POST', '/api/bookings', bookingBody(), clientToken);
  const id = created.data.booking.bookingId;
  const res = await mockRequest('GET', `/api/bookings/${id}`, undefined, adminToken);
  assert.equal(res.status, 200);
});

test('Privacy: bookings API requires authentication (401)', async () => {
  const res = await mockRequest('GET', '/api/bookings');
  assert.equal(res.status, 401);
});