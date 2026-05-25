// Mongo seed script — runs automatically on first container start
// (mongod picks up everything in /docker-entrypoint-initdb.d). Builds
// a small `shop` database with three collections so the document
// browser has nested documents, arrays, ObjectIds, and dates to
// render.

const shop = db.getSiblingDB('shop');

shop.users.insertMany([
  {
    _id: ObjectId(),
    email: 'alice@example.com',
    name: 'Alice Carter',
    active: true,
    tags: ['vip', 'beta'],
    profile: { country: 'US', timezone: 'America/Los_Angeles' },
    createdAt: new Date('2024-11-12T10:30:00Z'),
  },
  {
    _id: ObjectId(),
    email: 'bob@example.com',
    name: 'Bob Lin',
    active: true,
    tags: ['returning'],
    profile: { country: 'SG', timezone: 'Asia/Singapore' },
    createdAt: new Date('2025-01-04T08:15:00Z'),
  },
  {
    _id: ObjectId(),
    email: 'carol@example.com',
    name: 'Carol Dean',
    active: false,
    tags: [],
    profile: { country: 'UK', timezone: 'Europe/London' },
    createdAt: new Date('2025-02-18T14:00:00Z'),
  },
]);

shop.products.insertMany([
  {
    _id: ObjectId(),
    sku: 'SKU-1001',
    name: 'Mechanical keyboard',
    price: 129.99,
    stock: 42,
    categories: ['peripherals', 'keyboards'],
    specs: { switch: 'tactile', layout: 'ANSI', backlight: true },
  },
  {
    _id: ObjectId(),
    sku: 'SKU-1002',
    name: 'USB-C hub',
    price: 39.5,
    stock: 120,
    categories: ['peripherals', 'adapters'],
    specs: { ports: 7, power_delivery: 100 },
  },
  {
    _id: ObjectId(),
    sku: 'SKU-1003',
    name: 'Standing desk',
    price: 549.0,
    stock: 8,
    categories: ['furniture'],
    specs: { weight_capacity_kg: 80, motorized: true },
  },
]);

shop.orders.insertMany([
  {
    _id: ObjectId(),
    order_number: 'A-1001',
    status: 'shipped',
    total: 169.49,
    items: [
      { sku: 'SKU-1001', qty: 1, price: 129.99 },
      { sku: 'SKU-1002', qty: 1, price: 39.5 },
    ],
    placedAt: new Date('2025-04-02T18:00:00Z'),
  },
  {
    _id: ObjectId(),
    order_number: 'A-1002',
    status: 'pending',
    total: 549.0,
    items: [{ sku: 'SKU-1003', qty: 1, price: 549.0 }],
    placedAt: new Date('2025-05-10T09:30:00Z'),
  },
]);

print('Seeded shop database — users, products, orders');
