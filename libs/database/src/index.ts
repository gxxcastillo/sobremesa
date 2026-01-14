// Client
export {
  getClient,
  getServiceClient,
  createDatabaseClient,
  resetClients,
  getDatabaseConfig,
  type DatabaseConfig,
} from './lib/client';

// Base repository
export {
  BaseRepository,
  snakeToCamel,
  camelToSnake,
  mapRowToCamelCase,
  mapRecordToSnakeCase,
} from './lib/base-repository';

// Repositories
export * from './lib/repositories/index';

// Database initialization utilities
export { initDb, isDbInitialized, getMissingTables } from './lib/init-db';
