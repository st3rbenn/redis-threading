import { Redis } from 'ioredis';
import { EventEmitter } from 'events';
import { RedisConfig } from '../types/config';
import { Logger } from '../utils/logger';
import { RedisClientFactory } from '../utils/redis-client';
import { Serializer } from '../utils/serialization';

/**
 * Gestionnaire d'état partagé basé sur Redis
 * Permet de partager des données entre processus de manière synchronisée
 */
export class SharedState extends EventEmitter {
  private static instance: SharedState;
  private client: Redis;
  private subscriberClient: Redis;
  private logger: Logger;
  private locks: Map<string, NodeJS.Timeout> = new Map();
  private isShuttingDown: boolean = false;

  private constructor(
    private redisConfig: RedisConfig,
    private namespace: string = 'rt'
  ) {
    super();
    this.logger = new Logger('SharedState');

    // Obtenir les clients Redis
    const factory = RedisClientFactory.getInstance();
    this.client = factory.getClient(redisConfig, 'shared-state');
    this.subscriberClient = factory.getSubscriberClient(redisConfig);

    // Configurer l'abonnement aux changements
    this.setupSubscriber();
  }

  /**
   * Obtient l'instance unique du gestionnaire d'état
   */
  public static getInstance(redisConfig?: RedisConfig, namespace?: string): SharedState {
    if (!SharedState.instance) {
      if (!redisConfig) {
        throw new Error('Redis config is required for first initialization');
      }
      SharedState.instance = new SharedState(redisConfig, namespace);
    }
    return SharedState.instance;
  }

  /**
   * Configure le subscriber pour les notifications de changement
   */
  private setupSubscriber(): void {
    const channel = `${this.namespace}:state:changes`;

    this.subscriberClient.subscribe(channel, (err) => {
      if (err) {
        this.logger.error(`Error subscribing to state changes channel ${channel}`, err);
      } else {
        this.logger.debug(`Subscribed to state changes channel: ${channel}`);
      }
    });

    this.subscriberClient.on('message', (receivedChannel, message) => {
      if (this.isShuttingDown || receivedChannel !== channel) return;

      try {
        const change = Serializer.deserialize<{
          key: string;
          type: 'set' | 'delete' | 'expire';
          timestamp: number;
        }>(message);

        // Émettre l'événement de changement
        this.emit(`change:${change.key}`, { type: change.type, timestamp: change.timestamp });
        this.emit('change', { key: change.key, type: change.type, timestamp: change.timestamp });
      } catch (error) {
        this.logger.error('Error handling state change notification', error);
      }
    });
  }

  /**
   * Publie une notification de changement
   */
  private async notifyChange(
    key: string,
    type: 'set' | 'delete' | 'expire'
  ): Promise<void> {
    const channel = `${this.namespace}:state:changes`;

    await this.client.publish(
      channel,
      Serializer.serialize({
        key,
        type,
        timestamp: Date.now()
      })
    );
  }

  /**
   * Obtient la clé Redis complète pour une clé donnée
   */
  private getFullKey(key: string): string {
    return `${this.namespace}:state:${key}`;
  }

  /**
   * Stocke une valeur dans l'état partagé
   */
  public async set<T = any>(
    key: string,
    value: T,
    options?: {
      ttl?: number; // TTL en secondes
      ifNotExists?: boolean; // Ne définir que si la clé n'existe pas
    }
  ): Promise<boolean> {
    const fullKey = this.getFullKey(key);
    let result: string | null = null;

    const serializedValue = Serializer.serialize(value);

    if (options?.ifNotExists) {
      // Utiliser SET avec NX (only set if not exists)
      result = await this.client.set(
        fullKey,
        serializedValue,
        'KEEPTTL',
      );
    } else {
      // Set normal avec TTL optionnel
      result = await this.client.set(
        fullKey,
        serializedValue,
      );
    }

    if (result === 'OK') {
      await this.notifyChange(key, 'set');
      return true;
    }

    return false;
  }

  /**
   * Récupère une valeur de l'état partagé
   */
  public async get<T = any>(key: string): Promise<T | null> {
    const fullKey = this.getFullKey(key);
    const value = await this.client.get(fullKey);

    if (!value) return null;

    return Serializer.deserialize<T>(value);
  }

  /**
   * Supprime une clé de l'état partagé
   */
  public async delete(key: string): Promise<boolean> {
    const fullKey = this.getFullKey(key);
    const result = await this.client.del(fullKey);

    if (result > 0) {
      await this.notifyChange(key, 'delete');
      return true;
    }

    return false;
  }

  /**
   * Définit une durée d'expiration pour une clé
   */
  public async expire(key: string, seconds: number): Promise<boolean> {
    const fullKey = this.getFullKey(key);
    const result = await this.client.expire(fullKey, seconds);

    if (result === 1) {
      await this.notifyChange(key, 'expire');
      return true;
    }

    return false;
  }

  /**
   * Vérifie si une clé existe
   */
  public async exists(key: string): Promise<boolean> {
    const fullKey = this.getFullKey(key);
    const result = await this.client.exists(fullKey);
    return result === 1;
  }

  /**
   * Incrémente un compteur
   */
  public async increment(key: string, increment: number = 1): Promise<number> {
    const fullKey = this.getFullKey(key);
    const result = await this.client.incrby(fullKey, increment);
    await this.notifyChange(key, 'set');
    return result;
  }

  /**
   * Décrémente un compteur
   */
  public async decrement(key: string, decrement: number = 1): Promise<number> {
    const fullKey = this.getFullKey(key);
    const result = await this.client.decrby(fullKey, decrement);
    await this.notifyChange(key, 'set');
    return result;
  }

  /**
   * Acquiert un verrou distribué
   */
  public async acquireLock(
    lockName: string,
    ttl: number = 30
  ): Promise<boolean> {
    const fullKey = `${this.namespace}:lock:${lockName}`;
    const token = Date.now().toString();

    const result = await this.client.set(
      fullKey,
      token,
      'NX',
    );

    if (result === 'OK') {
      // Stocker le token localement
      const timeoutId = setTimeout(() => {
        this.locks.delete(lockName);
      }, ttl * 1000);

      this.locks.set(lockName, timeoutId);
      return true;
    }

    return false;
  }

  /**
   * Relâche un verrou distribué
   */
  public async releaseLock(lockName: string): Promise<boolean> {
    const fullKey = `${this.namespace}:lock:${lockName}`;

    // Supprimer le timeout local
    const timeoutId = this.locks.get(lockName);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.locks.delete(lockName);
    }

    // Supprimer le verrou dans Redis
    const result = await this.client.del(fullKey);
    return result === 1;
  }

  /**
   * Obtient toutes les clés correspondant à un pattern
   */
  public async getKeys(pattern: string): Promise<string[]> {
    const fullPattern = `${this.namespace}:state:${pattern}`;
    const keys = await this.client.keys(fullPattern);

    // Retirer le préfixe
    return keys.map(key => key.replace(`${this.namespace}:state:`, ''));
  }

  /**
   * Récupère plusieurs valeurs en une seule opération
   */
  public async getMulti<T = any>(keys: string[]): Promise<Map<string, T | null>> {
    if (keys.length === 0) {
      return new Map();
    }

    const fullKeys = keys.map(key => this.getFullKey(key));
    const values = await this.client.mget(...fullKeys);

    const result = new Map<string, T | null>();

    for (let i = 0; i < keys.length; i++) {
      const value = values[i];
      result.set(keys[i], value ? Serializer.deserialize<T>(value) : null);
    }

    return result;
  }

  /**
   * Stocke plusieurs valeurs en une seule opération
   */
  public async setMulti<T = any>(data: Map<string, T>): Promise<void> {
    if (data.size === 0) {
      return;
    }

    const pipeline = this.client.pipeline();

    for (const [key, value] of data.entries()) {
      const fullKey = this.getFullKey(key);
      pipeline.set(fullKey, Serializer.serialize(value));
    }

    await pipeline.exec();

    // Notifier les changements
    for (const key of data.keys()) {
      await this.notifyChange(key, 'set');
    }
  }

  /**
   * S'abonne aux changements d'une clé
   */
  public onChange(
    key: string,
    callback: (data: { type: 'set' | 'delete' | 'expire'; timestamp: number }) => void
  ): () => void {
    const eventName = `change:${key}`;
    this.on(eventName, callback);

    // Retourner une fonction pour se désabonner
    return () => {
      this.off(eventName, callback);
    };
  }

  /**
   * S'abonne à tous les changements
   */
  public onAnyChange(
    callback: (data: { key: string; type: 'set' | 'delete' | 'expire'; timestamp: number }) => void
  ): () => void {
    this.on('change', callback);

    // Retourner une fonction pour se désabonner
    return () => {
      this.off('change', callback);
    };
  }

  /**
   * Arrête le gestionnaire d'état
   */
  public async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;

    this.isShuttingDown = true;
    this.logger.info('Shutting down shared state manager...');

    // Annuler tous les timeouts de verrous
    for (const [lockName, timeoutId] of this.locks.entries()) {
      clearTimeout(timeoutId);
      this.locks.delete(lockName);
    }

    // Se désabonner du canal de changements
    await this.subscriberClient.unsubscribe(`${this.namespace}:state:changes`);

    this.logger.info('Shared state manager shutdown complete');
  }
}
