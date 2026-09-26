import { MongoClient, type Db } from "mongodb";
import { TomokError, safeStorageError } from "./errors";

type Connection = { uri: string; client: MongoClient; ready: Promise<MongoClient> };
const state = globalThis as typeof globalThis & { tomokMongo?: Connection };

export function storageConfiguration() {
  const uri = process.env.MONGODB_URI?.trim();
  const database = process.env.MONGODB_DATABASE?.trim();
  return {
    configured: Boolean(uri && database),
    storage: uri && database ? (/\.mongodb\.net(?:[/:?]|$)/i.test(uri) ? "atlas" as const : "mongodb" as const) : null,
  };
}

export async function projectDb(): Promise<Db> {
  const uri = process.env.MONGODB_URI?.trim();
  const database = process.env.MONGODB_DATABASE?.trim();
  if (!uri || !database) throw new TomokError("Project evidence is not available yet. Ask your administrator to connect project storage and import the source files.");
  try {
    if (!state.tomokMongo || state.tomokMongo.uri !== uri) {
      if (state.tomokMongo) await state.tomokMongo.client.close();
      const client = new MongoClient(uri, { maxPoolSize: 10, serverSelectionTimeoutMS: 8_000, connectTimeoutMS: 8_000, timeoutMS: 15_000 });
      state.tomokMongo = { uri, client, ready: client.connect() };
    }
    await state.tomokMongo.ready;
    return state.tomokMongo.client.db(database);
  } catch (error) {
    await closeProjectDb();
    return safeStorageError(error);
  }
}

export async function closeProjectDb() {
  const previous = state.tomokMongo;
  delete state.tomokMongo;
  await previous?.client.close().catch(() => {});
}
