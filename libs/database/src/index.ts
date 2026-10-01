// Client
export {
  createDatabaseClient,
  type DatabaseClient,
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

// Services
export * from './lib/services/index';
