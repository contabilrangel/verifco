import { defineConfig } from 'drizzle-kit';
export default defineConfig({ dialect: 'postgresql', schema: './src/db/platform-schema.ts', out: './drizzle-platform' });
