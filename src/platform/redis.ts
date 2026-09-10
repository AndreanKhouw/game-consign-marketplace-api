import { Redis } from 'ioredis';

import type { AppConfig } from './config.js';

export function createRedis(config: AppConfig): Redis {
  return new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    connectionName: 'game-consign-api',
  });
}
