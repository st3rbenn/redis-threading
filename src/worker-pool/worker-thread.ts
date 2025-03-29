import { Worker, WorkerOptions } from 'worker_threads';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { Task, TaskResult } from '../types/task';
import { Logger } from '../utils/logger';
import * as path from 'path';

/**
 * Représente un worker thread individuel
 */
export class WorkerThread extends EventEmitter {
  private worker: Worker | null = null;
  private taskTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private logger: Logger;
  public id: string;
  public busy: boolean = false;
  public startTime: number = 0;
  public lastActivityTime: number = Date.now();
  public stats = {
    tasksProcessed: 0,
    errors: 0,
    totalExecutionTime: 0
  };

  /**
   * Crée un nouveau worker thread
   * @param scriptPath Chemin vers le script worker
   * @param workerData Données à passer au worker
   * @param options Options du worker
   */
  constructor(
    private scriptPath: string,
    private workerData: any = {},
    private options: WorkerOptions = {}
  ) {
    super();
    this.id = uuidv4();
    this.logger = new Logger(`WorkerThread-${this.id.substr(0, 8)}`);
  }

  /**
   * Démarre le worker thread
   */
  public start(): Promise<void> {
    if (this.worker) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      try {
        // S'assurer que le chemin est absolu
        const workerPath = path.isAbsolute(this.scriptPath)
          ? this.scriptPath
          : path.resolve(process.cwd(), this.scriptPath);

        this.worker = new Worker(workerPath, {
          ...this.options,
          workerData: {
            ...this.workerData,
            workerId: this.id
          }
        });

        this.worker.on('online', () => {
          this.logger.info('Worker started successfully');
          this.lastActivityTime = Date.now();
          resolve();
        });

        this.worker.on('message', this.handleWorkerMessage.bind(this));
        this.worker.on('error', this.handleWorkerError.bind(this));
        this.worker.on('exit', this.handleWorkerExit.bind(this));
      } catch (error) {
        this.logger.error('Failed to start worker', error);
        reject(error);
      }
    });
  }

  /**
   * Exécute une tâche sur ce worker
   * @param task Tâche à exécuter
   * @param timeout Timeout en ms
   */
  public executeTask<TInput = any, TOutput = any>(
    task: Task<TInput, TOutput>,
    timeout: number = 30000
  ): Promise<TaskResult<TOutput>> {
    if (!this.worker || this.busy) {
      return Promise.reject(new Error('Worker not available'));
    }

    this.busy = true;
    this.startTime = Date.now();
    this.lastActivityTime = this.startTime;

    return new Promise((resolve, reject) => {
      // Configurer le timeout
      const timeoutId = setTimeout(() => {
        this.taskTimeouts.delete(task.id);
        this.busy = false;

        const timeoutError: TaskResult = {
          taskId: task.id,
          error: {
            name: 'TimeoutError',
            message: `Task execution timed out after ${timeout}ms`
          },
          completedAt: Date.now(),
          executionTime: Date.now() - this.startTime,
          workerId: this.id
        };

        this.logger.warn(`Task ${task.id} timed out after ${timeout}ms`);
        this.stats.errors++;

        // Émettre l'événement de timeout
        this.emit('task:timeout', timeoutError);

        reject(timeoutError);
      }, timeout);

      this.taskTimeouts.set(task.id, timeoutId);

      // Handler de message pour cette tâche spécifique
      const messageHandler = (message: any) => {
        if (message.type === 'task:result' && message.taskId === task.id) {
          const endTime = Date.now();
          const executionTime = endTime - this.startTime;

          // Nettoyer le timeout
          clearTimeout(this.taskTimeouts.get(task.id));
          this.taskTimeouts.delete(task.id);
          this.busy = false;
          this.lastActivityTime = endTime;

          // Mettre à jour les statistiques
          this.stats.tasksProcessed++;
          this.stats.totalExecutionTime += executionTime;

          if (message.error) {
            this.stats.errors++;
          }

          // Construire le résultat
          const result: TaskResult<TOutput> = {
            taskId: task.id,
            result: message.result,
            error: message.error,
            completedAt: endTime,
            executionTime,
            workerId: this.id
          };

          // Supprimer le listener spécifique à cette tâche
          this.worker?.removeListener('message', messageHandler);

          // Émettre l'événement de complétion
          if (message.error) {
            this.emit('task:error', result);
            reject(result);
          } else {
            this.emit('task:completed', result);
            resolve(result);
          }
        }
      };

      // Ajouter le handler temporaire
      this.worker?.on('message', messageHandler);

      // Envoyer la tâche au worker
      this.worker?.postMessage({
        type: 'task:execute',
        task
      });

      this.logger.debug(`Task ${task.id} sent to worker`);
    });
  }

  /**
   * Termine le worker thread
   */
  public terminate(): Promise<number> {
    if (!this.worker) {
      return Promise.resolve(0);
    }

    // Annuler tous les timeouts
    for (const [taskId, timeoutId] of this.taskTimeouts.entries()) {
      clearTimeout(timeoutId);
      this.taskTimeouts.delete(taskId);
    }

    return this.worker.terminate();
  }

  /**
   * Termine le worker s'il est inactif depuis trop longtemps
   * @param maxIdleTime Temps maximum d'inactivité en ms
   */
  public terminateIfIdle(maxIdleTime: number): boolean {
    if (this.busy) return false;

    const idleTime = Date.now() - this.lastActivityTime;
    if (idleTime > maxIdleTime) {
      this.logger.info(`Terminating idle worker (inactive for ${idleTime}ms)`);
      this.terminate().catch(err => {
        this.logger.error('Error terminating idle worker', err);
      });
      return true;
    }

    return false;
  }

  /**
   * Vérifie si le worker est en bonne santé
   */
  public isHealthy(): boolean {
    return this.worker !== null && !this.worker;
  }

  /**
   * Gère les messages génériques du worker
   */
  private handleWorkerMessage(message: any): void {
    this.lastActivityTime = Date.now();

    if (message.type === 'log') {
      switch (message.level) {
        case 'error':
          this.logger.error(`[Worker] ${message.message}`, message.data);
          break;
        case 'warn':
          this.logger.warn(`[Worker] ${message.message}`, message.data);
          break;
        case 'info':
          this.logger.info(`[Worker] ${message.message}`, message.data);
          break;
        case 'debug':
          this.logger.debug(`[Worker] ${message.message}`, message.data);
          break;
        default:
          this.logger.info(`[Worker] ${message.message}`, message.data);
      }
    } else if (message.type === 'health:report') {
      this.emit('health:report', {
        workerId: this.id,
        ...message.data
      });
    }
  }

  /**
   * Gère les erreurs du worker
   */
  private handleWorkerError(error: Error): void {
    this.logger.error('Worker error', error);
    this.stats.errors++;
    this.emit('error', {
      workerId: this.id,
      error
    });
  }

  /**
   * Gère la sortie du worker
   */
  private handleWorkerExit(code: number): void {
    this.logger.info(`Worker exited with code ${code}`);
    this.worker = null;
    this.busy = false;

    // Nettoyer les timeouts
    for (const [taskId, timeoutId] of this.taskTimeouts.entries()) {
      clearTimeout(timeoutId);
      this.taskTimeouts.delete(taskId);
    }

    this.emit('exit', {
      workerId: this.id,
      code
    });
  }
}
