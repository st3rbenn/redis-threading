import { Redis } from 'ioredis';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { Task, TaskResult, TaskStatus } from '../types/task';
import { RedisConfig } from '../types/config';
import { Logger } from '../utils/logger';
import { RedisClientFactory } from '../utils/redis-client';
import { Serializer } from '../utils/serialization';

export class TaskQueue extends EventEmitter {
  private client: Redis;
  private subscriberClient: Redis;
  private logger: Logger;
  private processingTasks: Map<string, {
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();
  private isConsumerRunning: boolean = false;
  private consumerActive: boolean = false;
  private pollingInterval: number = 1000;
  private shutdownRequested: boolean = false;

  constructor(
    private redisConfig: RedisConfig,
    private queueName: string = 'default',
    private namespace: string = 'rt'
  ) {
    super();
    this.logger = new Logger(`TaskQueue:${queueName}`);

    const factory = RedisClientFactory.getInstance();
    this.client = factory.getClient(redisConfig, `queue:${queueName}`);
    this.subscriberClient = factory.getSubscriberClient(redisConfig);

    this.setupResultSubscriber();
  }

  private get keys() {
    return {
      pendingList: `${this.namespace}:queue:${this.queueName}:pending`,
      processingList: `${this.namespace}:queue:${this.queueName}:processing`,
      taskHashKey: (taskId: string) => `${this.namespace}:task:${taskId}`,
      resultChannel: `${this.namespace}:results:${this.queueName}`,
      resultHashKey: (taskId: string) => `${this.namespace}:result:${taskId}`,
    };
  }

  public async enqueue<TInput = any, TOutput = any>(
    taskType: string,
    data: TInput,
    options: {
      priority?: number;
      timeout?: number;
      retries?: number;
      delay?: number;
    } = {}
  ): Promise<TaskResult<TOutput>> {
    const task: Task<TInput> = {
      id: uuidv4(),
      type: taskType,
      data,
      options,
      createdAt: Date.now(),
      status: TaskStatus.PENDING
    };

    this.logger.debug(`Enqueuing task ${task.id} of type ${taskType}`);

    await this.client.hset(
      this.keys.taskHashKey(task.id),
      'data', Serializer.serialize(task)
    );

    await this.client.expire(
      this.keys.taskHashKey(task.id),
      (options.timeout || 3600) + 60
    );

    if (options.delay && options.delay > 0) {
      await this.client.zadd(
        `${this.namespace}:queue:${this.queueName}:delayed`,
        Date.now() + options.delay,
        task.id
      );
      this.logger.debug(`Task ${task.id} delayed for ${options.delay}ms`);
    } else {
      await this.client.rpush(this.keys.pendingList, task.id);
    }

    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeout || 30000;

      const timeoutId = setTimeout(() => {
        this.processingTasks.delete(task.id);

        const timeoutError: TaskResult = {
          taskId: task.id,
          error: {
            name: 'TimeoutError',
            message: `Task execution timed out after ${timeoutMs}ms`
          },
          completedAt: Date.now(),
          executionTime: Date.now() - (task.createdAt || Date.now()),
          workerId: 'unknown'
        };

        this.logger.warn(`Task ${task.id} timed out after ${timeoutMs}ms`);
        this.emit('task:timeout', timeoutError);

        reject(timeoutError);
      }, timeoutMs);

      this.processingTasks.set(task.id, {
        resolve,
        reject,
        timeout: timeoutId
      });
    });
  }

  public startConsumer(
    processTask: (task: Task) => Promise<any>,
    concurrency: number = 1
  ): void {
    if (this.isConsumerRunning) {
      this.logger.warn('Consumer is already running');
      return;
    }

    this.logger.info(`Starting consumer with concurrency ${concurrency}`);
    this.isConsumerRunning = true;
    this.consumerActive = true;

    this.startDelayedTasksProcessor();

    for (let i = 0; i < concurrency; i++) {
      this.consumeTasks(processTask, i);
    }
  }

  private startDelayedTasksProcessor(): void {
    const checkInterval = setInterval(async () => {
      if (this.shutdownRequested) {
        clearInterval(checkInterval);
        return;
      }

      try {
        const now = Date.now();
        const delayedKey = `${this.namespace}:queue:${this.queueName}:delayed`;

        const taskIds = await this.client.zrangebyscore(delayedKey, 0, now);

        if (taskIds.length === 0) return;

        this.logger.debug(`Moving ${taskIds.length} delayed tasks to pending queue`);

        const pipeline = this.client.pipeline();

        for (const taskId of taskIds) {
          pipeline.rpush(this.keys.pendingList, taskId);
          pipeline.zrem(delayedKey, taskId);
        }

        await pipeline.exec();
      } catch (error) {
        this.logger.error('Error processing delayed tasks', error);
      }
    }, 1000);
  }

  private async consumeTasks(
    processTask: (task: Task) => Promise<any>,
    workerId: number
  ): Promise<void> {
    const workerName = `consumer-${workerId}`;
    this.logger.debug(`${workerName} started`);

    while (this.consumerActive && !this.shutdownRequested) {
      try {
        const result = await this.client.blpop(
          this.keys.pendingList,
          this.pollingInterval / 1000
        );

        if (!result) continue;

        const taskId = result[1];
        this.logger.debug(`${workerName} processing task ${taskId}`);

        await this.client.rpush(this.keys.processingList, taskId);

        const taskData = await this.client.hget(this.keys.taskHashKey(taskId), 'data');

        if (!taskData) {
          this.logger.warn(`${workerName}: Task ${taskId} data not found`);
          await this.client.lrem(this.keys.processingList, 0, taskId);
          continue;
        }

        const task = Serializer.deserialize<Task>(taskData);
        task.status = TaskStatus.PROCESSING;

        await this.client.hset(
          this.keys.taskHashKey(taskId),
          'data', Serializer.serialize(task)
        );

        const startTime = Date.now();
        try {
          const result = await processTask(task);

          const taskResult: TaskResult = {
            taskId: task.id,
            result,
            completedAt: Date.now(),
            executionTime: Date.now() - startTime,
            workerId: workerName
          };

          task.status = TaskStatus.COMPLETED;
          await this.client.hset(
            this.keys.taskHashKey(taskId),
            'data', Serializer.serialize(task)
          );

          await this.storeResult(taskResult);

          this.logger.debug(`${workerName}: Task ${taskId} completed in ${taskResult.executionTime}ms`);
        } catch (error: any) {
          const taskResult: TaskResult = {
            taskId: task.id,
            error: {
              name: error.name || 'Error',
              message: error.message || String(error),
              stack: error.stack
            },
            completedAt: Date.now(),
            executionTime: Date.now() - startTime,
            workerId: workerName
          };

          task.status = TaskStatus.FAILED;
          await this.client.hset(
            this.keys.taskHashKey(taskId),
            'data', Serializer.serialize(task)
          );

          await this.storeResult(taskResult);

          this.logger.warn(`${workerName}: Task ${taskId} failed: ${error.message}`);
        }

        await this.client.lrem(this.keys.processingList, 0, taskId);
      } catch (error) {
        this.logger.error(`${workerName}: Error consuming tasks`, error);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    this.logger.info(`${workerName} stopped`);
  }

  private async storeResult(result: TaskResult): Promise<void> {
    await this.client.hset(
      this.keys.resultHashKey(result.taskId),
      'data', Serializer.serialize(result)
    );

    await this.client.expire(this.keys.resultHashKey(result.taskId), 3600);

    await this.client.publish(
      this.keys.resultChannel,
      Serializer.serialize({ type: 'task:result', result })
    );
  }

  private setupResultSubscriber(): void {
    this.subscriberClient.subscribe(this.keys.resultChannel, (err) => {
      if (err) {
        this.logger.error('Error subscribing to result channel', err);
        return;
      }

      this.logger.debug(`Subscribed to result channel: ${this.keys.resultChannel}`);
    });

    this.subscriberClient.on('message', (channel, message) => {
      if (channel !== this.keys.resultChannel) return;

      try {
        const data = Serializer.deserialize<{ type: string; result: TaskResult }>(message);

        if (data.type === 'task:result') {
          this.handleTaskResult(data.result);
        }
      } catch (error) {
        this.logger.error('Error handling result message', error);
      }
    });
  }

  private handleTaskResult(result: TaskResult): void {
    const taskId = result.taskId;
    const taskPromise = this.processingTasks.get(taskId);

    if (!taskPromise) {
      // Personne n'attend ce résultat
      return;
    }

    // Nettoyer le timeout
    clearTimeout(taskPromise.timeout);
    this.processingTasks.delete(taskId);

    // Résoudre la promesse
    if (result.error) {
      this.emit('task:error', result);
      taskPromise.reject(result);
    } else {
      this.emit('task:completed', result);
      taskPromise.resolve(result);
    }
  }

  /**
   * Obtenir l'état d'une tâche par son ID
   */
  public async getTaskStatus(taskId: string): Promise<Task | null> {
    const taskData = await this.client.hget(this.keys.taskHashKey(taskId), 'data');

    if (!taskData) return null;

    return Serializer.deserialize<Task>(taskData);
  }

  /**
   * Obtenir le résultat d'une tâche par son ID
   */
  public async getTaskResult(taskId: string): Promise<TaskResult | null> {
    const resultData = await this.client.hget(this.keys.resultHashKey(taskId), 'data');

    if (!resultData) return null;

    return Serializer.deserialize<TaskResult>(resultData);
  }

  /**
   * Obtenir des statistiques sur la file d'attente
   */
  public async getStats(): Promise<{
    pending: number;
    processing: number;
    delayed: number;
  }> {
    const [pending, processing, delayed] = await Promise.all([
      this.client.llen(this.keys.pendingList),
      this.client.llen(this.keys.processingList),
      this.client.zcard(`${this.namespace}:queue:${this.queueName}:delayed`)
    ]);

    return {
      pending,
      processing,
      delayed
    };
  }

  /**
   * Récupérer les tâches bloquées (en cours depuis trop longtemps)
   */
  public async recoverStaleTasks(maxAge: number = 300000): Promise<number> {
    const now = Date.now();
    const processingTasks = await this.client.lrange(this.keys.processingList, 0, -1);

    if (processingTasks.length === 0) return 0;

    let recoverCount = 0;
    const pipeline = this.client.pipeline();

    for (const taskId of processingTasks) {
      // Récupérer les données de la tâche
      const taskData = await this.client.hget(this.keys.taskHashKey(taskId), 'data');

      if (!taskData) continue;

      const task = Serializer.deserialize<Task>(taskData);

      // Vérifier si la tâche est bloquée
      if (
        task.status === TaskStatus.PROCESSING &&
        task.createdAt &&
        now - task.createdAt > maxAge
      ) {
        // Remettre la tâche dans la file d'attente
        pipeline.lrem(this.keys.processingList, 0, taskId);
        pipeline.rpush(this.keys.pendingList, taskId);

        // Mettre à jour le statut
        task.status = TaskStatus.PENDING;
        pipeline.hset(
          this.keys.taskHashKey(taskId),
          'data', Serializer.serialize(task)
        );

        recoverCount++;
      }
    }

    if (recoverCount > 0) {
      await pipeline.exec();
      this.logger.info(`Recovered ${recoverCount} stale tasks`);
    }

    return recoverCount;
  }

  /**
   * Arrêter le consommateur
   */
  public async shutdown(timeout: number = 10000): Promise<void> {
    if (!this.isConsumerRunning) return;

    this.logger.info('Shutting down task queue...');
    this.shutdownRequested = true;
    this.consumerActive = false;

    // Attendre que les tâches en cours se terminent
    const pendingPromises = Array.from(this.processingTasks.values()).map(
      ({ timeout }) => clearTimeout(timeout)
    );

    // Attendre un peu pour laisser le temps aux tâches de se terminer
    await Promise.race([
      Promise.all(pendingPromises),
      new Promise(resolve => setTimeout(resolve, timeout))
    ]);

    // Se désabonner du canal de résultats
    await this.subscriberClient.unsubscribe(this.keys.resultChannel);

    this.isConsumerRunning = false;
    this.logger.info('Task queue shutdown complete');
  }
}
