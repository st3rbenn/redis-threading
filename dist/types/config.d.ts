export type RedisConfig = {
    host: string;
    port: number;
    password?: string;
    db?: number;
    keyPrefix?: string;
};
export type WorkerPoolConfig = {
    minWorkers?: number;
    maxWorkers?: number;
    idleTimeout?: number;
    taskTimeout?: number;
    workerOptions?: {
        resourceLimits?: {
            maxOldGenerationSizeMb?: number;
            maxYoungGenerationSizeMb?: number;
            codeRangeSizeMb?: number;
        };
    };
};
export type RedisThreadingConfig = {
    redis: RedisConfig;
    workerPool?: WorkerPoolConfig;
    logLevel?: 'error' | 'warn' | 'info' | 'debug' | 'trace';
    namespace?: string;
    shutdownTimeout?: number;
};
