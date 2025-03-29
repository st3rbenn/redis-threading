import { EventEmitter } from 'events';
import { TaskQueue } from './task-queue';
import { TaskHandler, Task, TaskResult } from '../types/task';
import { RedisConfig } from '../types/config';
import { Logger } from '../utils/logger';

/**
 * Gestionnaire de files d'attente
 * Implémente le pattern Façade
 */
export class QueueManager extends EventEmitter {
  private static instance: QueueManager;
  private queues: Map<string, TaskQueue> = new Map();
  private taskHandlers: Map<string, TaskHandler> = new Map();
  private logger: Logger;
  private isConsumerRunning: boolean = false;
  private consumerConcurrency: number = 1;
  private staleTasks = {
    checkInterval: 60000, // 1 minute
    maxAge: 300000, // 5 minutes
    intervalId: null as NodeJS.Timeout | null
  };

  private constructor(
    private redisConfig: RedisConfig,
    private namespace: string = 'rt'
  ) {
    super();
    this.logger = new Logger('QueueManager');
  }

  /**
   * Obtient l'instance unique du gestionnaire
   */
  public static getInstance(redisConfig?: RedisConfig, namespace?: string): QueueManager {
    if (!QueueManager.instance) {
      if (!redisConfig) {
        throw new Error('Redis config is required for first initialization');
      }
      QueueManager.instance = new QueueManager(redisConfig, namespace);
    }
    return QueueManager.instance;
  }

  /**
   * Obtient ou crée une file d'attente
   */
  public getQueue(queueName: string = 'default'): TaskQueue {
    if (this.queues.has(queueName)) {
      return this.queues.get(queueName)!;
    }

    const queue = new TaskQueue(this.redisConfig, queueName, this.namespace);

    // Configurer les événements
    queue.on('task:completed', this.handleTaskCompleted.bind(this));
    queue.on('task:error', this.handleTaskError.bind(this));
    queue.on('task:timeout', this.handleTaskTimeout.bind(this));

    this.queues.set(queueName, queue);
    return queue;
  }

  /**
   * Enfile une tâche et attend son résultat
   */
  public async enqueue<TInput = any, TOutput = any>(
    taskType: string,
    data: TInput,
    options: {
      queueName?: string;
      priority?: number;
      timeout?: number;
      retries?: number;
      delay?: number;
    } = {}
  ): Promise<TaskResult<TOutput>> {
    const queueName = options.queueName || 'default';
    const queue = this.getQueue(queueName);

    return queue.enqueue<TInput, TOutput>(
      taskType,
      data,
      {
        priority: options.priority,
        timeout: options.timeout,
        retries: options.retries,
        delay: options.delay
      }
    );
  }

  /**
   * Enregistre un gestionnaire de tâche
   */
  public registerTaskHandler<TInput = any, TOutput = any>(
    taskType: string,
    handler: TaskHandler<TInput, TOutput>
  ): void {
    this.taskHandlers.set(taskType, handler as TaskHandler);
    this.logger.debug(`Registered handler for task type: ${taskType}`);
  }

  /**
   * Démarre le consommateur de tâches
   */
  public startConsumer(
    concurrency: number = 1,
    queueNames: string[] = ['default']
  ): void {
    if (this.isConsumerRunning) {
      this.logger.warn('Consumer is already running');
      return;
    }

    this.logger.info(`Starting consumer with concurrency ${concurrency} for queues: ${queueNames.join(', ')}`);
    this.consumerConcurrency = concurrency;
    this.isConsumerRunning = true;

    // Démarrer le consommateur pour chaque file d'attente
    for (const queueName of queueNames) {
      const queue = this.getQueue(queueName);
      queue.startConsumer(this.processTask.bind(this), concurrency);
    }

    // Démarrer la vérification des tâches bloquées
    this.startStaleTasksCheck();
  }

  /**
   * Traite une tâche
   */
  private async processTask(task: Task): Promise<any> {
    const handler = this.taskHandlers.get(task.type);

    if (!handler) {
      throw new Error(`No handler registered for task type: ${task.type}`);
    }

    this.logger.debug(`Processing task ${task.id} of type ${task.type}`);
    return handler(task.data, { id: task.id, type: task.type });
  }

  /**
   * Démarre la vérification des tâches bloquées
   */
  private startStaleTasksCheck(): void {
    if (this.staleTasks.intervalId) {
      clearInterval(this.staleTasks.intervalId);
    }

    this.staleTasks.intervalId = setInterval(async () => {
      try {
        let totalRecovered = 0;

        for (const [queueName, queue] of this.queues.entries()) {
          const recovered = await queue.recoverStaleTasks(this.staleTasks.maxAge);
          totalRecovered += recovered;
        }

        if (totalRecovered > 0) {
          this.logger.info(`Recovered ${totalRecovered} stale tasks across all queues`);
        }
      } catch (error) {
        this.logger.error('Error checking for stale tasks', error);
      }
    }, this.staleTasks.checkInterval);
  }

  /**
   * Gère la complétion d'une tâche
   */
  private handleTaskCompleted(result: TaskResult): void {
    this.logger.debug(`Task ${result.taskId} completed by worker ${result.workerId}`);
    this.emit('task:completed', result);
  }

  /**
   * Gère les erreurs de tâche
   */
  private handleTaskError(result: TaskResult): void {
    this.logger.warn(`Task ${result.taskId} failed with error:`, result.error);
    this.emit('task:error', result);
  }

  /**
   * Gère les timeouts de tâche
   */
  private handleTaskTimeout(result: TaskResult): void {
    this.logger.warn(`Task ${result.taskId} timed out after ${result.executionTime}ms`);
    this.emit('task:timeout', result);
  }

  /**
   * Obtient des statistiques sur toutes les files d'attente
   */
  public async getStats(): Promise<{
    queues: {
      [queueName: string]: {
        pending: number;
        processing: number;
        delayed: number;
      }
    };
    handlers: string[];
  }> {
    const queueStats: any = {};

    for (const [queueName, queue] of this.queues.entries()) {
      queueStats[queueName] = await queue.getStats();
    }

    return {
      queues: queueStats,
      handlers: Array.from(this.taskHandlers.keys())
    };
  }

  /**
   * Arrête tous les consommateurs
   */
  public async shutdown(timeout: number = 10000): Promise<void> {
    if (!this.isConsumerRunning) return;

    this.logger.info('Shutting down queue manager...');

    // Arrêter la vérification des tâches bloquées
    if (this.staleTasks.intervalId) {
      clearInterval(this.staleTasks.intervalId);
      this.staleTasks.intervalId = null;
    }

    // Arrêter tous les consommateurs
    const shutdownPromises = [];
    for (const [queueName, queue] of this.queues.entries()) {
      shutdownPromises.push(queue.shutdown(timeout));
    }

    await Promise.all(shutdownPromises);
    this.isConsumerRunning = false;
    this.logger.info('Queue manager shutdown complete');
  }
}
