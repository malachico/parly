import { createMongoDb } from './mongo.js';
import type { Database } from './types.js';

/** Creates the database client: MongoDB at MONGODB_URI (required). */
export function createDb(): Database {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required: set it to your MongoDB connection string (see docs/configuration.md)');
  return createMongoDb(process.env.MONGODB_URI);
}
