import type { Config } from './config.interface';

const config: Config = {
  nest: {
    port: 3000,
  },
  cors: {
    enabled: true,
    // CORS_ORIGINS: comma-separated allowed origins for prod (e.g. the deployed
    // frontend's URL). Unset → allow all, matching prior local-dev behavior.
    origin: process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
      : true,
  },
  swagger: {
    enabled: true,
    title: 'BuildCore API',
    description: 'BuildCore ERP — REST API',
    version: '1.0',
    path: 'api',
  },
  security: {
    expiresIn: '15m',
    refreshIn: '7d',
  },
};

export default (): Config => config;
