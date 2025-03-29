import IORedis, { Redis } from 'ioredis';
import { RedisConfig } from '../types/config';
import { EventEmitter } from 'events';
import { Logger } from './logger';

/**
 * Factory et gestionnaire de clients Redis
 * Utilise le pattern Singleton pour éviter de créer trop de connexions
 */
export class RedisClientFactory {
  private static instance: RedisClientFactory;
  private clients: Map<string, Redis> = new Map();
  private logger: Logger;
  private events: EventEmitter = new EventEmitter();

  private constructor() {
    this.logger = new Logger('RedisClientFactory');
  }

  /**
   * Obtenir l'instance unique de la factory
   */
  public static getInstance(): RedisClientFactory {
    if (!RedisClientFactory.instance) {
      RedisClientFactory.instance = new RedisClientFactory();
    }
    return RedisClientFactory.instance;
  }

  /**
   * Crée ou récupère un client Redis
   * @param config Configuration Redis
   * @param clientName Nom du client (pour réutilisation)
   */
  public getClient(config: RedisConfig, clientName: string = 'default'): Redis {
    const cacheKey = `${clientName}:${config.host}:${config.port}:${config.db || 0}`;

    if (this.clients.has(cacheKey)) {
      return this.clients.get(cacheKey)!;
    }

    this.logger.info(`Creating new Redis client: ${cacheKey}`);
    const client = new IORedis({
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db || 0,
      keyPrefix: config.keyPrefix,

      // Options de reconnexion automatique
      retryStrategy: (times) => {
        const delay = Math.min(times * 100, 3000);
        this.logger.warn(`Redis connection attempt ${times} failed. Retrying in ${delay}ms...`);
        return delay;
      },

      // Limiter le nombre maximum de tentatives de reconnexion
      maxRetriesPerRequest: 5
    });

    // Gestion des événements
    client.on('connect', () => {
      this.logger.info(`Redis client connected: ${cacheKey}`);
      this.events.emit('connect', { client: cacheKey });
    });

    client.on('error', (err) => {
      this.logger.error(`Redis client error: ${cacheKey}`, err);
      this.events.emit('error', { client: cacheKey, error: err });
    });

    client.on('reconnecting', (time: number) => {
      this.logger.warn(`Redis client reconnecting after ${time}ms: ${cacheKey}`);
      this.events.emit('reconnecting', { client: cacheKey, time });
    });

    client.on('close', () => {
      this.logger.warn(`Redis client connection closed: ${cacheKey}`);
      this.events.emit('close', { client: cacheKey });
    });

    this.clients.set(cacheKey, client);
    return client;
  }

  /**
   * Obtient un client dédié à la publication
   */
  public getPublisherClient(config: RedisConfig): Redis {
    return this.getClient(config, 'publisher');
  }

  /**
   * Obtient un client dédié à l'abonnement
   */
  public getSubscriberClient(config: RedisConfig): Redis {
    return this.getClient(config, 'subscriber');
  }

  /**
   * Ferme tous les clients Redis
   */
  public async closeAll(): Promise<void> {
    const closePromises: Promise<string>[] = [];

    for (const [key, client] of this.clients.entries()) {
      closePromises.push(
        new Promise((resolve) => {
          client.quit().then(() => {
            this.logger.info(`Redis client closed: ${key}`);
            resolve(key);
          });
        })
      );
    }

    await Promise.all(closePromises);
    this.clients.clear();
  }

  /**
   * S'abonne aux événements Redis
   */
  public on(
    event: 'connect' | 'error' | 'reconnecting' | 'close',
    listener: (data: any) => void
  ): void {
    this.events.on(event, listener);
  }
}
