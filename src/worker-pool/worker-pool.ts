import { cpus } from 'os';
import { EventEmitter } from 'events';
import { WorkerThread } from './worker-thread';
import { Task, TaskResult } from '../types/task';
import { WorkerPoolConfig } from '../types/config';
import { Logger } from '../utils/logger';
import * as path from 'path';

/**
 * Gère un pool de workers pour l'exécution des tâches
 * Implémente le pattern Pool d'objets et Singleton
 */
export class WorkerPool extends EventEmitter {
  private static instance: WorkerPool;
  private workers: Map<string, WorkerThread> = new Map();
  private taskQueue: Task[] = [];
  private idleCheckInterval: NodeJS.Timeout | null = null;
  private logger: Logger;
  private isShuttingDown: boolean = false;

  private constructor(
    private workerScriptPath: string,
    private config: WorkerPoolConfig = {},
    private workerData: any = {}
  ) {
    super();
    this.logger = new Logger('WorkerPool');

    // Valeurs par défaut pour la configuration
    this.config = {
      minWorkers: Math.max(1, cpus().length - 1),
      maxWorkers: cpus().length * 2,
      idleTimeout: 60000, // 1 minute
      taskTimeout: 30000, // 30 secondes
      ...config
    };

    // S'assurer que le chemin du script worker est absolu
    this.workerScriptPath = path.isAbsolute(workerScriptPath)
      ? workerScriptPath
      : path.resolve(process.cwd(), workerScriptPath);

    this.startIdleCheck();
    this.initializeWorkers();
  }

  /**
   * Obtient l'instance unique du pool de workers
   */
  public static getInstance(
    workerScriptPath?: string,
    config?: WorkerPoolConfig,
    workerData?: any
  ): WorkerPool {
    if (!WorkerPool.instance) {
      if (!workerScriptPath) {
        throw new Error('Worker script path is required for first initialization');
      }
      WorkerPool.instance = new WorkerPool(workerScriptPath, config, workerData);
    }
    return WorkerPool.instance;
  }

  /**
   * Initialise les workers au démarrage
   */
  private async initializeWorkers(): Promise<void> {
    const minWorkers = this.config.minWorkers || 1;

    this.logger.info(`Initializing worker pool with ${minWorkers} workers`);

    // Créer les workers initiaux
    const initPromises = [];
    for (let i = 0; i < minWorkers; i++) {
      initPromises.push(this.createWorker());
    }

    await Promise.all(initPromises);
    this.logger.info(`Worker pool initialized with ${this.workers.size} workers`);
  }

  /**
   * Vérifie périodiquement les workers inactifs
   */
  private startIdleCheck(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
    }

    this.idleCheckInterval = setInterval(() => {
      if (this.isShuttingDown) return;

      // Ne pas terminer les workers si en dessous du minimum
      if (this.workers.size <= (this.config.minWorkers || 1)) return;

      const idleTimeout = this.config.idleTimeout || 60000;

      let terminatedCount = 0;
      for (const [id, worker] of this.workers.entries()) {
        // Ne pas descendre en dessous du minimum
        if (this.workers.size - terminatedCount <= (this.config.minWorkers || 1)) {
          break;
        }

        if (worker.terminateIfIdle(idleTimeout)) {
          this.workers.delete(id);
          terminatedCount++;
        }
      }

      if (terminatedCount > 0) {
        this.logger.info(`Terminated ${terminatedCount} idle workers`);
      }

      // Traiter les tâches en attente s'il y en a
      this.processQueue();
    }, 30000); // Vérifier toutes les 30 secondes
  }

  /**
   * Crée un nouveau worker thread
   */
  private async createWorker(): Promise<WorkerThread> {
    const worker = new WorkerThread(
      this.workerScriptPath,
      this.workerData,
      this.config.workerOptions
    );

    // Configurer les listeners d'événements
    worker.on('error', this.handleWorkerError.bind(this));
    worker.on('exit', this.handleWorkerExit.bind(this));
    worker.on('task:completed', this.handleTaskCompleted.bind(this));
    worker.on('task:error', this.handleTaskError.bind(this));
    worker.on('task:timeout', this.handleTaskTimeout.bind(this));
    worker.on('health:report', this.handleHealthReport.bind(this));

    // Démarrer le worker
    await worker.start();
    this.workers.set(worker.id, worker);

    return worker;
  }

  /**
   * Exécute une tâche sur un worker disponible
   * @param task Tâche à exécuter
   */
  public async executeTask<TInput = any, TOutput = any>(
    task: Task<TInput, TOutput>
  ): Promise<TaskResult<TOutput>> {
    if (this.isShuttingDown) {
      return Promise.reject(new Error('Worker pool is shutting down'));
    }

    // Trouver un worker disponible
    const availableWorker = this.findAvailableWorker();

    if (availableWorker) {
      return availableWorker.executeTask(task, this.config.taskTimeout);
    }

    // Si on peut créer un nouveau worker, le faire
    if (this.workers.size < (this.config.maxWorkers || cpus().length * 2)) {
      try {
        const newWorker = await this.createWorker();
        this.logger.info(`Created new worker (total: ${this.workers.size})`);
        return newWorker.executeTask(task, this.config.taskTimeout);
      } catch (error) {
        this.logger.error('Failed to create new worker', error);
        // Si on ne peut pas créer de worker, mettre en file d'attente
      }
    }

    // Mettre la tâche en file d'attente
    return new Promise((resolve, reject) => {
      // Ajouter un callback à la tâche
      const enhancedTask = {
        ...task,
        __callbacks: {
          resolve,
          reject
        }
      };

      this.taskQueue.push(enhancedTask);
      this.logger.debug(`Task ${task.id} queued (queue size: ${this.taskQueue.length})`);
      this.emit('task:queued', { taskId: task.id });
    });
  }

  /**
   * Traite les tâches en file d'attente
   */
  private processQueue(): void {
    if (this.taskQueue.length === 0) return;

    // Traiter autant de tâches que possible
    while (this.taskQueue.length > 0) {
      const availableWorker = this.findAvailableWorker();
      if (!availableWorker) break;

      const task = this.taskQueue.shift() as any;
      if (!task) break;

      const { __callbacks, ...pureTask } = task;

      availableWorker.executeTask(pureTask, this.config.taskTimeout)
        .then(__callbacks.resolve)
        .catch(__callbacks.reject);

      this.logger.debug(`Dequeued task ${pureTask.id} (queue size: ${this.taskQueue.length})`);
    }
  }

  /**
   * Trouve un worker disponible
   */
  private findAvailableWorker(): WorkerThread | null {
    for (const [, worker] of this.workers) {
      if (!worker.busy && worker.isHealthy()) {
        return worker;
      }
    }
    return null;
  }

  /**
   * Gère les erreurs de worker
   */
  private handleWorkerError(data: { workerId: string, error: Error }): void {
    this.logger.error(`Worker ${data.workerId} error:`, data.error);
    this.emit('worker:error', data);

    // Si le worker est toujours dans le pool, le retirer
    if (this.workers.has(data.workerId)) {
      this.workers.delete(data.workerId);
    }

    // Créer un nouveau worker si nécessaire
    if (this.workers.size < (this.config.minWorkers || 1) && !this.isShuttingDown) {
      this.createWorker().catch(err => {
        this.logger.error('Failed to create replacement worker', err);
      });
    }

    // Traiter les tâches en attente
    this.processQueue();
  }

  /**
   * Gère la sortie d'un worker
   */
  private handleWorkerExit(data: { workerId: string, code: number }): void {
    this.logger.info(`Worker ${data.workerId} exited with code ${data.code}`);
    this.emit('worker:exit', data);

    // Supprimer le worker du pool
    if (this.workers.has(data.workerId)) {
      this.workers.delete(data.workerId);
    }

    // Créer un nouveau worker si nécessaire
    if (this.workers.size < (this.config.minWorkers || 1) && !this.isShuttingDown) {
      this.createWorker().catch(err => {
        this.logger.error('Failed to create replacement worker', err);
      });
    }

    // Traiter les tâches en attente
    this.processQueue();
  }

  /**
   * Gère la complétion d'une tâche
   */
  private handleTaskCompleted(result: TaskResult): void {
    this.logger.debug(`Task ${result.taskId} completed by worker ${result.workerId}`);
    this.emit('task:completed', result);
    this.processQueue();
  }

  /**
   * Gère les erreurs de tâche
   */
  private handleTaskError(result: TaskResult): void {
    this.logger.warn(`Task ${result.taskId} failed with error:`, result.error);
    this.emit('task:error', result);
    this.processQueue();
  }

  /**
   * Gère les timeouts de tâche
   */
  private handleTaskTimeout(result: TaskResult): void {
    this.logger.warn(`Task ${result.taskId} timed out after ${result.executionTime}ms`);
    this.emit('task:timeout', result);
    this.processQueue();
  }

  /**
   * Gère les rapports de santé des workers
   */
  private handleHealthReport(report: any): void {
    this.logger.debug(`Health report from worker ${report.workerId}`, report);
    this.emit('health:report', report);
  }

  /**
   * Arrête proprement le pool de workers
   */
  public async shutdown(timeout: number = 10000): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;
    this.logger.info(`Shutting down worker pool (${this.workers.size} workers)...`);

    // Arrêter la vérification d'inactivité
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }

    // Rejeter les tâches en attente
    const pendingTasks = this.taskQueue.length;
    if (pendingTasks > 0) {
      this.logger.warn(`Rejecting ${pendingTasks} pending tasks`);
      this.taskQueue.forEach((task: any) => {
        if (task.__callbacks && task.__callbacks.reject) {
          task.__callbacks.reject(new Error('Worker pool is shutting down'));
        }
      });
      this.taskQueue = [];
    }

    // Arrêter tous les workers
    const terminatePromises = [];
    for (const [id, worker] of this.workers.entries()) {
      terminatePromises.push(
        Promise.race([
          worker.terminate(),
          new Promise(resolve => setTimeout(resolve, timeout))
        ]).then(() => {
          this.workers.delete(id);
        })
      );
    }

    await Promise.all(terminatePromises);
    this.logger.info('Worker pool shutdown complete');
  }

  /**
   * Obtient les statistiques du pool
   */
  public getStats(): any {
    const workerStats = Array.from(this.workers.values()).map(worker => ({
      id: worker.id,
      busy: worker.busy,
      stats: worker.stats,
      lastActivity: worker.lastActivityTime
    }));

    return {
      workers: {
        total: this.workers.size,
        busy: Array.from(this.workers.values()).filter(w => w.busy).length,
        idle: Array.from(this.workers.values()).filter(w => !w.busy).length,
        details: workerStats
      },
      queue: {
        length: this.taskQueue.length
      }
    };
  }
}
