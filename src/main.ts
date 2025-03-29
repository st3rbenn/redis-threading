import { cpus } from 'os';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { WorkerPool } from './worker-pool/worker-pool';
import { TaskExecutor } from './worker-pool/task-executor';
import { QueueManager } from './queue/queue-manager';
import { MessageBroker } from './communication/message-broker';
import { SharedState } from './communication/shared-state';
import { HealthMonitor } from './monitoring/health-monitor';
import { MetricsCollector } from './monitoring/metrics-collector';
import { Task, TaskHandler, TaskResult, TaskStatus } from './types/task';
import { Message, MessageHandler } from './types/message';
import { RedisConfig, RedisThreadingConfig, WorkerPoolConfig } from './types/config';
import { Logger } from './utils/logger';
import { RedisClientFactory } from './utils/redis-client';
import { Serializer } from './utils/serialization';
import * as path from 'path';

/**
 * Classe principale qui regroupe toutes les fonctionnalités de la bibliothèque
 * Implémente le pattern Façade
 */
export class RedisThreading extends EventEmitter {
  private logger: Logger;
  private config: RedisThreadingConfig;
  private workerPool: WorkerPool | null = null;
  private queueManager: QueueManager | null = null;
  private messageBroker: MessageBroker | null = null;
  private sharedState: SharedState | null = null;
  private healthMonitor: HealthMonitor | null = null;
  private nodeId: string;
  private isInitialized: boolean = false;
  private isShuttingDown: boolean = false;

  constructor(config: RedisThreadingConfig) {
    super();
    this.config = this.normalizeConfig(config);
    this.nodeId = uuidv4();
    this.logger = new Logger('RedisThreading');

    // Configurer le niveau de log global
    Logger.setLogLevel(this.config.logLevel || 'info');
  }

  /**
   * Normalise la configuration
   */
  private normalizeConfig(config: RedisThreadingConfig): RedisThreadingConfig {
    return {
      ...config,
      workerPool: {
        minWorkers: config.workerPool?.minWorkers || Math.max(1, cpus().length - 1),
        maxWorkers: config.workerPool?.maxWorkers || cpus().length * 2,
        idleTimeout: config.workerPool?.idleTimeout || 60000,
        taskTimeout: config.workerPool?.taskTimeout || 30000,
        ...(config.workerPool || {})
      },
      namespace: config.namespace || 'rt',
      logLevel: config.logLevel || 'info',
      shutdownTimeout: config.shutdownTimeout || 10000
    };
  }

  /**
   * Initialise la bibliothèque
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      this.logger.warn('RedisThreading is already initialized');
      return;
    }

    this.logger.info(`Initializing RedisThreading (Node ID: ${this.nodeId})`);

    try {
      // Initialiser le gestionnaire d'état partagé
      this.sharedState = SharedState.getInstance(this.config.redis, this.config.namespace);

      // Initialiser le broker de messages
      this.messageBroker = MessageBroker.getInstance(this.config.redis, this.config.namespace);

      // Initialiser le gestionnaire de files d'attente
      this.queueManager = QueueManager.getInstance(this.config.redis, this.config.namespace);

      // Initialiser le moniteur de santé
      this.healthMonitor = new HealthMonitor(10000, this.nodeId);
      this.healthMonitor.connectToSharedState(this.sharedState);

      // Configurer le moniteur de santé
      this.healthMonitor.on('alert', (alert) => {
        this.logger.warn(`Health alert: ${alert.message}`);
        this.emit('health:alert', alert);
      });

      this.healthMonitor.on('metrics:update', (metrics) => {
        this.emit('metrics:update', metrics);
      });

      // Enregistrer la présence du nœud
      await this.sharedState.set(
        `nodes:${this.nodeId}:info`,
        {
          id: this.nodeId,
          hostname: require('os').hostname(),
          pid: process.pid,
          startTime: Date.now(),
          version: require('../package.json').version
        },
        { ttl: 60 } // Expire après 60 secondes si pas de mise à jour
      );

      // Démarrer le ping de présence
      this.startPresencePing();

      // Démarrer le moniteur de santé
      this.healthMonitor.start();

      this.isInitialized = true;
      this.logger.info('RedisThreading initialized successfully');
    } catch (error) {
      this.logger.error('Error initializing RedisThreading', error);
      throw error;
    }
  }

  /**
   * Ping périodique pour maintenir la présence du nœud
   */
  private startPresencePing(): void {
    setInterval(async () => {
      if (this.isShuttingDown || !this.sharedState) return;

      // Renouveler la présence du nœud
      await this.sharedState.expire(`nodes:${this.nodeId}:info`, 60);
    }, 30000); // Ping toutes les 30 secondes
  }

  /**
   * Initialise le worker pool
   */
  public async initializeWorkerPool(workerScriptPath: string, workerData?: any): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('RedisThreading must be initialized first');
    }

    if (this.workerPool) {
      this.logger.warn('Worker pool is already initialized');
      return;
    }

    // S'assurer que le chemin est absolu
    const absolutePath = path.isAbsolute(workerScriptPath)
      ? workerScriptPath
      : path.resolve(process.cwd(), workerScriptPath);

    this.logger.info(`Initializing worker pool with script: ${absolutePath}`);

    this.workerPool = WorkerPool.getInstance(
      absolutePath,
      this.config.workerPool,
      {
        ...workerData,
        nodeId: this.nodeId,
        redisConfig: this.config.redis,
        namespace: this.config.namespace
      }
    );

    // Configurer les événements du worker pool
    this.workerPool.on('worker:error', (data) => {
      this.logger.error(`Worker ${data.workerId} error:`, data.error);
      this.emit('worker:error', data);
    });

    this.workerPool.on('task:completed', (result) => {
      this.logger.debug(`Task ${result.taskId} completed successfully`);
      this.emit('task:completed', result);
    });

    this.workerPool.on('task:error', (result) => {
      this.logger.warn(`Task ${result.taskId} failed:`, result.error);
      this.emit('task:error', result);
    });

    this.workerPool.on('task:timeout', (result) => {
      this.logger.warn(`Task ${result.taskId} timed out`);
      this.emit('task:timeout', result);
    });
  }

  /**
   * Démarre la consommation de tâches depuis Redis
   */
  public startQueueConsumer(
    concurrency: number = 2,
    queueNames: string[] = ['default']
  ): void {
    if (!this.isInitialized) {
      throw new Error('RedisThreading must be initialized first');
    }

    if (!this.queueManager) {
      throw new Error('Queue manager is not initialized');
    }

    this.logger.info(`Starting queue consumer with concurrency ${concurrency} for queues: ${queueNames.join(', ')}`);

    // Configurer les événements du queue manager
    this.queueManager.on('task:completed', (result) => {
      this.emit('task:completed', result);
    });

    this.queueManager.on('task:error', (result) => {
      this.emit('task:error', result);
    });

    this.queueManager.on('task:timeout', (result) => {
      this.emit('task:timeout', result);
    });

    // Démarrer le consommateur
    this.queueManager.startConsumer(concurrency, queueNames);
  }

  /**
   * Enregistre un gestionnaire de tâche
   */
  public registerTaskHandler<TInput = any, TOutput = any>(
    taskType: string,
    handler: TaskHandler<TInput, TOutput>
  ): void {
    if (!this.queueManager) {
      throw new Error('Queue manager is not initialized');
    }

    this.logger.info(`Registering handler for task type: ${taskType}`);
    this.queueManager.registerTaskHandler(taskType, handler);
  }

  /**
   * Exécute une tâche en local
   */
  public async executeTask<TInput = any, TOutput = any>(
    taskType: string,
    data: TInput,
    options?: {
      timeout?: number;
    }
  ): Promise<TaskResult<TOutput>> {
    if (!this.workerPool) {
      throw new Error('Worker pool is not initialized');
    }

    const task: Task<TInput> = {
      id: uuidv4(),
      type: taskType,
      data,
      options: {
        timeout: options?.timeout
      },
      createdAt: Date.now(),
      status: TaskStatus.PENDING
    };

    this.logger.debug(`Executing task ${task.id} of type ${taskType} locally`);
    return this.workerPool.executeTask<TInput, TOutput>(task);
  }

  /**
   * Enfile une tâche dans Redis
   */
  public async enqueueTask<TInput = any, TOutput = any>(
    taskType: string,
    data: TInput,
    options?: {
      queueName?: string;
      priority?: number;
      timeout?: number;
      retries?: number;
      delay?: number;
    }
  ): Promise<TaskResult<TOutput>> {
    if (!this.queueManager) {
      throw new Error('Queue manager is not initialized');
    }

    this.logger.debug(`Enqueuing task of type ${taskType} to queue ${options?.queueName || 'default'}`);
    return this.queueManager.enqueue<TInput, TOutput>(taskType, data, options);
  }

  /**
   * S'abonne à un canal de message
   */
  public subscribeToChannel<T = any>(
    channel: string,
    handler: (data: T) => void
  ): () => void {
    if (!this.messageBroker) {
      throw new Error('Message broker is not initialized');
    }

    this.logger.debug(`Subscribing to channel: ${channel}`);
    return this.messageBroker.subscribe(channel, (message: Message<T>) => {
      handler(message.data);
    });
  }

  /**
   * Publie un message sur un canal
   */
  public async publishToChannel<T = any>(
    channel: string,
    data: T
  ): Promise<void> {
    if (!this.messageBroker) {
      throw new Error('Message broker is not initialized');
    }

    this.logger.debug(`Publishing message to channel: ${channel}`);
    await this.messageBroker.publish<T>(channel, data);
  }

  /**
   * Envoie une requête et attend une réponse
   */
  public async sendRequest<TRequest = any, TResponse = any>(
    channel: string,
    data: TRequest,
    timeout: number = 30000
  ): Promise<TResponse> {
    if (!this.messageBroker) {
      throw new Error('Message broker is not initialized');
    }

    this.logger.debug(`Sending request to channel: ${channel}`);
    return this.messageBroker.request<TRequest, TResponse>(channel, data, timeout);
  }

  /**
   * Stocke une valeur dans l'état partagé
   */
  public async setState<T = any>(
    key: string,
    value: T,
    options?: {
      ttl?: number;
      ifNotExists?: boolean;
    }
  ): Promise<boolean> {
    if (!this.sharedState) {
      throw new Error('Shared state is not initialized');
    }

    return this.sharedState.set<T>(key, value, options);
  }

  /**
   * Récupère une valeur de l'état partagé
   */
  public async getState<T = any>(key: string): Promise<T | null> {
    if (!this.sharedState) {
      throw new Error('Shared state is not initialized');
    }

    return this.sharedState.get<T>(key);
  }

  /**
   * S'abonne aux changements d'une clé dans l'état partagé
   */
  public onStateChange<T = any>(
    key: string,
    callback: (value: T | null) => void
  ): () => void {
    if (!this.sharedState) {
      throw new Error('Shared state is not initialized');
    }

    // Obtenir la valeur initiale
    this.sharedState.get<T>(key).then(value => {
      callback(value);
    });

    return this.sharedState.onChange(key, async () => {
      const value = await this.sharedState!.get<T>(key);
      callback(value);
    });
  }

  /**
   * Supprime une clé de l'état partagé
   */
  public async deleteState(key: string): Promise<boolean> {
    if (!this.sharedState) {
      throw new Error('Shared state is not initialized');
    }

    return this.sharedState.delete(key);
  }

  /**
   * Acquiert un verrou distribué
   */
  public async acquireLock(
    lockName: string,
    ttl: number = 30
  ): Promise<boolean> {
    if (!this.sharedState) {
      throw new Error('Shared state is not initialized');
    }

    return this.sharedState.acquireLock(lockName, ttl);
  }

  /**
   * Relâche un verrou distribué
   */
  public async releaseLock(lockName: string): Promise<boolean> {
    if (!this.sharedState) {
      throw new Error('Shared state is not initialized');
    }

    return this.sharedState.releaseLock(lockName);
  }

  /**
   * Obtient des métriques de santé
   */
  public getHealthMetrics(): any {
    if (!this.healthMonitor) {
      throw new Error('Health monitor is not initialized');
    }

    return this.healthMonitor.getLatestMetrics();
  }

  /**
   * Obtient des statistiques sur les workers et les files d'attente
   */
  public async getStats(): Promise<{
    nodeId: string;
    workers?: {
      total: number;
      busy: number;
      idle: number;
    };
    queues?: {
      [queueName: string]: {
        pending: number;
        processing: number;
        delayed: number;
      };
    };
    health: any;
  }> {
    const stats: any = {
      nodeId: this.nodeId,
      health: this.healthMonitor ? this.healthMonitor.getLatestMetrics() : null
    };

    // Stats du worker pool
    if (this.workerPool) {
      const workerStats = this.workerPool.getStats();
      stats.workers = workerStats.workers;
    }

    // Stats des files d'attente
    if (this.queueManager) {
      const queueStats = await this.queueManager.getStats();
      stats.queues = queueStats.queues;
      stats.handlers = queueStats.handlers;
    }

    return stats;
  }

  /**
   * Arrête proprement tous les services
   */
  public async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      this.logger.warn('Shutdown already in progress');
      return;
    }

    this.isShuttingDown = true;
    this.logger.info('Shutting down RedisThreading...');

    // Stopper le moniteur de santé
    if (this.healthMonitor) {
      await this.healthMonitor.stop();
    }

    // Supprimer l'info du nœud
    if (this.sharedState) {
      await this.sharedState.delete(`nodes:${this.nodeId}:info`);
    }

    // Arrêter les workers
    if (this.workerPool) {
      await this.workerPool.shutdown(this.config.shutdownTimeout);
    }

    // Arrêter le gestionnaire de files d'attente
    if (this.queueManager) {
      await this.queueManager.shutdown(this.config.shutdownTimeout);
    }

    // Arrêter le broker de messages
    if (this.messageBroker) {
      await this.messageBroker.shutdown();
    }

    // Arrêter le gestionnaire d'état partagé
    if (this.sharedState) {
      await this.sharedState.shutdown();
    }

    // Fermer toutes les connexions Redis
    const factory = RedisClientFactory.getInstance();
    await factory.closeAll();

    this.logger.info('RedisThreading shutdown complete');
  }
}

// Exports pour utilisation directe
export {
  Task,
  TaskResult,
  TaskStatus,
  TaskHandler,
  Message,
  MessageHandler,
  TaskExecutor,
  RedisConfig,
  WorkerPoolConfig,
  RedisThreadingConfig,
  Logger,
  Serializer
};

// Export default
export default RedisThreading;
