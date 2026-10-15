import { createStorage, loadStorageConfig } from 'platform';

const storage = createStorage(loadStorageConfig(process.env));
try {
  await storage.ensureBuckets();
  console.log('buckets ready: sources, sites');
} finally {
  storage.close();
}
