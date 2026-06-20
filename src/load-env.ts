import { config } from 'dotenv';

// Carrega o .env ANTES de qualquer módulo que leia process.env (env.ts).
// Importe este arquivo PRIMEIRO nos entrypoints (index.ts, jobs/runner.ts).
config();
