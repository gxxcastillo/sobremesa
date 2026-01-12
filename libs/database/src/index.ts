// Client
export {
  getClient,
  getServiceClient,
  createDatabaseClient,
  resetClients,
  getDatabaseConfig,
  type DatabaseConfig,
} from './lib/client.js';

// Base repository
export {
  BaseRepository,
  snakeToCamel,
  camelToSnake,
  mapRowToCamelCase,
  mapRecordToSnakeCase,
} from './lib/base-repository.js';

// Repositories
export * from './lib/repositories/index.js';

// Database initialization utilities
export { initDb, isDbInitialized, getMissingTables } from './lib/init-db.js';
