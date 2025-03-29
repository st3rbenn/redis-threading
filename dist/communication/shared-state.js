"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SharedState = void 0;
const events_1 = require("events");
const logger_1 = require("../utils/logger");
const redis_client_1 = require("../utils/redis-client");
const serialization_1 = require("../utils/serialization");
/**
 * Gestionnaire d'état partagé basé sur Redis
 * Permet de partager des données entre processus de manière synchronisée
 */
class SharedState extends events_1.EventEmitter {
    constructor(redisConfig, namespace = 'rt') {
        super();
        this.redisConfig = redisConfig;
        this.namespace = namespace;
        this.locks = new Map();
        this.isShuttingDown = false;
        this.logger = new logger_1.Logger('SharedState');
        // Obtenir les clients Redis
        const factory = redis_client_1.RedisClientFactory.getInstance();
        this.client = factory.getClient(redisConfig, 'shared-state');
        this.subscriberClient = factory.getSubscriberClient(redisConfig);
        // Configurer l'abonnement aux changements
        this.setupSubscriber();
    }
    /**
     * Obtient l'instance unique du gestionnaire d'état
     */
    static getInstance(redisConfig, namespace) {
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
    setupSubscriber() {
        const channel = `${this.namespace}:state:changes`;
        this.subscriberClient.subscribe(channel, (err) => {
            if (err) {
                this.logger.error(`Error subscribing to state changes channel ${channel}`, err);
            }
            else {
                this.logger.debug(`Subscribed to state changes channel: ${channel}`);
            }
        });
        this.subscriberClient.on('message', (receivedChannel, message) => {
            if (this.isShuttingDown || receivedChannel !== channel)
                return;
            try {
                const change = serialization_1.Serializer.deserialize(message);
                // Émettre l'événement de changement
                this.emit(`change:${change.key}`, { type: change.type, timestamp: change.timestamp });
                this.emit('change', { key: change.key, type: change.type, timestamp: change.timestamp });
            }
            catch (error) {
                this.logger.error('Error handling state change notification', error);
            }
        });
    }
    /**
     * Publie une notification de changement
     */
    async notifyChange(key, type) {
        const channel = `${this.namespace}:state:changes`;
        await this.client.publish(channel, serialization_1.Serializer.serialize({
            key,
            type,
            timestamp: Date.now()
        }));
    }
    /**
     * Obtient la clé Redis complète pour une clé donnée
     */
    getFullKey(key) {
        return `${this.namespace}:state:${key}`;
    }
    /**
     * Stocke une valeur dans l'état partagé
     */
    async set(key, value, options) {
        const fullKey = this.getFullKey(key);
        let result = null;
        const serializedValue = serialization_1.Serializer.serialize(value);
        if (options?.ifNotExists) {
            // Utiliser SET avec NX (only set if not exists)
            result = await this.client.set(fullKey, serializedValue, 'KEEPTTL');
        }
        else {
            // Set normal avec TTL optionnel
            result = await this.client.set(fullKey, serializedValue);
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
    async get(key) {
        const fullKey = this.getFullKey(key);
        const value = await this.client.get(fullKey);
        if (!value)
            return null;
        return serialization_1.Serializer.deserialize(value);
    }
    /**
     * Supprime une clé de l'état partagé
     */
    async delete(key) {
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
    async expire(key, seconds) {
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
    async exists(key) {
        const fullKey = this.getFullKey(key);
        const result = await this.client.exists(fullKey);
        return result === 1;
    }
    /**
     * Incrémente un compteur
     */
    async increment(key, increment = 1) {
        const fullKey = this.getFullKey(key);
        const result = await this.client.incrby(fullKey, increment);
        await this.notifyChange(key, 'set');
        return result;
    }
    /**
     * Décrémente un compteur
     */
    async decrement(key, decrement = 1) {
        const fullKey = this.getFullKey(key);
        const result = await this.client.decrby(fullKey, decrement);
        await this.notifyChange(key, 'set');
        return result;
    }
    /**
     * Acquiert un verrou distribué
     */
    async acquireLock(lockName, ttl = 30) {
        const fullKey = `${this.namespace}:lock:${lockName}`;
        const token = Date.now().toString();
        const result = await this.client.set(fullKey, token, 'NX');
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
    async releaseLock(lockName) {
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
    async getKeys(pattern) {
        const fullPattern = `${this.namespace}:state:${pattern}`;
        const keys = await this.client.keys(fullPattern);
        // Retirer le préfixe
        return keys.map(key => key.replace(`${this.namespace}:state:`, ''));
    }
    /**
     * Récupère plusieurs valeurs en une seule opération
     */
    async getMulti(keys) {
        if (keys.length === 0) {
            return new Map();
        }
        const fullKeys = keys.map(key => this.getFullKey(key));
        const values = await this.client.mget(...fullKeys);
        const result = new Map();
        for (let i = 0; i < keys.length; i++) {
            const value = values[i];
            result.set(keys[i], value ? serialization_1.Serializer.deserialize(value) : null);
        }
        return result;
    }
    /**
     * Stocke plusieurs valeurs en une seule opération
     */
    async setMulti(data) {
        if (data.size === 0) {
            return;
        }
        const pipeline = this.client.pipeline();
        for (const [key, value] of data.entries()) {
            const fullKey = this.getFullKey(key);
            pipeline.set(fullKey, serialization_1.Serializer.serialize(value));
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
    onChange(key, callback) {
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
    onAnyChange(callback) {
        this.on('change', callback);
        // Retourner une fonction pour se désabonner
        return () => {
            this.off('change', callback);
        };
    }
    /**
     * Arrête le gestionnaire d'état
     */
    async shutdown() {
        if (this.isShuttingDown)
            return;
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
exports.SharedState = SharedState;
//# sourceMappingURL=shared-state.js.map