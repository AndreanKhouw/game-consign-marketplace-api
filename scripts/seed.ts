import { loadConfig } from '../src/platform/config.js';
import { hashPassword } from '../src/platform/crypto.js';
import { createDatabasePool, withTransaction } from '../src/platform/database.js';

const config = loadConfig();
if (config.nodeEnv === 'production') {
  throw new Error('Development seed is disabled in production');
}

const pool = createDatabasePool(config);

interface SeedUser {
  email: string;
  password: string;
  displayName: string;
  roles: Array<'buyer' | 'seller' | 'admin'>;
  sellerName?: string;
}

const users: SeedUser[] = [
  {
    email: process.env.SEED_BUYER_EMAIL ?? 'buyer@example.test',
    password: process.env.SEED_BUYER_PASSWORD ?? 'Buyer-Test-Password-2026!',
    displayName: 'Demo Buyer',
    roles: ['buyer'],
  },
  {
    email: process.env.SEED_SELLER_EMAIL ?? 'seller@example.test',
    password: process.env.SEED_SELLER_PASSWORD ?? 'Seller-Test-Password-2026!',
    displayName: 'Demo Seller',
    roles: ['buyer', 'seller'],
    sellerName: 'Demo Game Store',
  },
  {
    email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.test',
    password: process.env.SEED_ADMIN_PASSWORD ?? 'Admin-Test-Password-2026!',
    displayName: 'Demo Admin',
    roles: ['buyer', 'admin'],
  },
];

try {
  await withTransaction(pool, config.databaseLockTimeoutMs, async (client) => {
    for (const user of users) {
      const email = user.email.trim().toLowerCase().normalize('NFC');
      const passwordHash = await hashPassword(user.password);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO users (email_normalized, password_hash, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (email_normalized) DO UPDATE
           SET display_name = EXCLUDED.display_name
         RETURNING id`,
        [email, passwordHash, user.displayName],
      );
      const userId = inserted.rows[0]!.id;

      for (const role of user.roles) {
        await client.query(
          `INSERT INTO user_roles (user_id, role)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [userId, role],
        );
      }

      if (user.sellerName) {
        const seller = await client.query<{ id: string }>(
          `INSERT INTO sellers (owner_user_id, name)
           VALUES ($1, $2)
           ON CONFLICT (owner_user_id) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [userId, user.sellerName],
        );
        const sellerId = seller.rows[0]!.id;
        await client.query(
          `INSERT INTO products
             (id, seller_id, name, description, category, price_minor, stock_quantity)
           VALUES
             ('10000000-0000-4000-8000-000000000001', $1, 'Final Fantasy VII Rebirth', 'PlayStation 5 physical edition', 'console_game', 899000, 5),
             ('10000000-0000-4000-8000-000000000002', $1, 'Pokemon Scarlet', 'Nintendo Switch physical edition', 'console_game', 649000, 1)
           ON CONFLICT (id) DO UPDATE
             SET seller_id = EXCLUDED.seller_id,
                 name = EXCLUDED.name,
                 description = EXCLUDED.description,
                 category = EXCLUDED.category,
                 price_minor = EXCLUDED.price_minor`,
          [sellerId],
        );
      }
    }
  });
  console.log('development seed complete');
} finally {
  await pool.end();
}
