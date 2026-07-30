// MongoDB seed script. Runs once at first container start.
db = db.getSiblingDB('shop');

db.users.insertMany([
  { _id: 1, email: 'alice@example.com', full_name: 'Alice Anderson', tier: 'gold' },
  { _id: 2, email: 'bob@example.com',   full_name: 'Bob Baker',      tier: 'silver' },
  { _id: 3, email: 'carol@example.com', full_name: 'Carol Chen',     tier: 'gold', beta: true },
  { _id: 4, email: 'dave@example.com',  full_name: 'Dave Diaz',      tier: 'bronze' },
]);

db.products.insertMany([
  { _id: 1, sku: 'LAPTOP-001', name: 'ThinkPad X1',   price: 1899.99, stock: 12, tags: ['work','portable'] },
  { _id: 2, sku: 'LAPTOP-002', name: 'MacBook Air',   price: 1299.00, stock:  8, tags: ['work','apple'] },
  { _id: 3, sku: 'BOOK-001',   name: 'Designing Data-Intensive Apps', price: 45.00, stock: 100, tags: ['tech'] },
  { _id: 4, sku: 'BOOK-002',   name: 'The Pragmatic Programmer',      price: 35.00, stock:  50, tags: ['tech'] },
]);

db.orders.insertMany([
  { _id: 1, user_id: 1, status: 'paid',    total: 1899.99, placed_at: new Date('2026-06-01') },
  { _id: 2, user_id: 1, status: 'pending', total:   45.00, placed_at: new Date('2026-06-05') },
  { _id: 3, user_id: 2, status: 'shipped', total: 1344.00, placed_at: new Date('2026-06-02') },
  { _id: 4, user_id: 3, status: 'paid',    total:   80.00, placed_at: new Date('2026-06-03') },
]);
