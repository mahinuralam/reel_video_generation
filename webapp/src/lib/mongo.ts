// One MongoDB client per process (Next.js server or worker), reused across requests.
import { MongoClient, type Db } from 'mongodb';
import { MONGODB_DB, MONGODB_URI } from './config';

const g = globalThis as unknown as { _mongoClient?: Promise<MongoClient>; _mongoIndexes?: Promise<void> };

export function getClient(): Promise<MongoClient> {
  if (!g._mongoClient) {
    g._mongoClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 4000 }).connect();
    g._mongoClient.catch(() => { g._mongoClient = undefined; });
  }
  return g._mongoClient;
}

export async function getDb(): Promise<Db> {
  const db = (await getClient()).db(MONGODB_DB);
  if (!g._mongoIndexes) {
    g._mongoIndexes = (async () => {
      await db.collection('jobs').createIndex({ name: 1 }, { unique: true });
      await db.collection('jobs').createIndex({ status: 1, queuedAt: 1 });
      await db.collection('jobs').createIndex({ createdAt: -1 });
    })();
  }
  await g._mongoIndexes;
  return db;
}
