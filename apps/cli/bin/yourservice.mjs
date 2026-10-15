#!/usr/bin/env node
// Runs the TypeScript source through tsx (no build step).
import process from 'node:process';
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/index.ts');
process.exitCode = await main(process.argv.slice(2));
