export type RedisConfig = {
  host: string;
  port: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
}

export type WorkerPoolConfig = {
  minWorkers?: number;  // Nombre minimum de workers (par défaut: nombre de cœurs CPU - 1)
  maxWorkers?: number;  // Nombre maximum de workers (par défaut: nombre de cœurs CPU * 2)
  idleTimeout?: number; // Délai avant de terminer un worker inactif (ms)
  taskTimeout?: number; // Délai maximum d'exécution d'une tâche (ms)
  workerOptions?: {
    resourceLimits?: {
      maxOldGenerationSizeMb?: number; // Limite de mémoire par worker
      maxYoungGenerationSizeMb?: number;
      codeRangeSizeMb?: number;
    }
  };
}

export type RedisThreadingConfig = {
  redis: RedisConfig;
  workerPool?: WorkerPoolConfig;
  logLevel?: 'error' | 'warn' | 'info' | 'debug' | 'trace';
  namespace?: string;    // Préfixe pour les clés Redis et canaux (pour éviter les collisions)
  shutdownTimeout?: number; // Délai de grâce pour l'arrêt propre (ms)
}
